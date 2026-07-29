import React, { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, YAxis, ResponsiveContainer } from "recharts";

// ---------- design tokens ----------
const T = {
  bg: "#0F1521",
  panel: "#161D2C",
  panelAlt: "#1B2436",
  border: "#2A3348",
  textPrimary: "#E8E6DE",
  textSecondary: "#8B92A8",
  textMuted: "#5B6376",
  brass: "#C9A961",
  brassDim: "#8A784F",
  buy: "#4ADE80",
  sell: "#F87171",
  hold: "#94A3B8",
  watch: "#E8B95C",
  mono: "ui-monospace, 'SF Mono', 'Roboto Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif",
};

// ---------- instrument config ----------
const ASSETS = [
  { id: "XAU", label: "Gold", pair: "XAU / USD", kind: "commodity", src: "gold-api", symbol: "XAU", quote: "USD", freshness: "live" },
  { id: "BTC", label: "Bitcoin", pair: "BTC / USD", kind: "crypto", src: "gold-api", symbol: "BTC", quote: "USD", freshness: "live" },
  { id: "EURUSD", label: "Euro", pair: "EUR / USD", kind: "forex", src: "frankfurter", base: "EUR", quote: "USD", freshness: "daily ref" },
  { id: "GBPUSD", label: "British Pound", pair: "GBP / USD", kind: "forex", src: "frankfurter", base: "GBP", quote: "USD", freshness: "daily ref" },
  { id: "USDJPY", label: "Japanese Yen", pair: "USD / JPY", kind: "forex", src: "frankfurter", base: "USD", quote: "JPY", freshness: "daily ref" },
  { id: "USDCHF", label: "Swiss Franc", pair: "USD / CHF", kind: "forex", src: "frankfurter", base: "USD", quote: "CHF", freshness: "daily ref" },
];

const SMA_FAST = 5;
const SMA_SLOW = 15;
const RSI_PERIOD = 14;
const MAX_HISTORY = 300;
const POLL_MS = 60000;
const STORAGE_KEY = "price-history";
const BB_PERIOD = 20;
const BB_INNER_MULT = 1;
const BB_OUTER_MULT = 2;
const CHART_WINDOW = 60;

// ---------- indicator math ----------
function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(prices, period = RSI_PERIOD) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// double Bollinger Bands: one inner band (BB_INNER_MULT std) and one outer band (BB_OUTER_MULT std),
// both built off the same rolling mean
function computeBollingerSeries(prices, period = BB_PERIOD) {
  return prices.map((price, i) => {
    if (i < period - 1) return { i, price };
    const window = prices.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return {
      i,
      price,
      mid: mean,
      upperInner: mean + BB_INNER_MULT * std,
      lowerInner: mean - BB_INNER_MULT * std,
      upperOuter: mean + BB_OUTER_MULT * std,
      lowerOuter: mean - BB_OUTER_MULT * std,
    };
  });
}

function computeSignal(prices) {
  if (prices.length < SMA_SLOW) {
    return { status: "collecting", label: "Collecting data", reason: `Need ${SMA_SLOW - prices.length} more reading${SMA_SLOW - prices.length === 1 ? "" : "s"}`, color: T.textMuted };
  }
  const fast = sma(prices, SMA_FAST);
  const slow = sma(prices, SMA_SLOW);
  const r = rsi(prices);
  const trendUp = fast > slow;
  const trendDown = fast < slow;

  if (r !== null && r >= 70) {
    return { status: "watch", label: "Overbought", reason: `RSI ${r.toFixed(0)} — trend is up but stretched; pullback risk`, color: T.watch, fast, slow, r };
  }
  if (r !== null && r <= 30) {
    return { status: "watch", label: "Oversold", reason: `RSI ${r.toFixed(0)} — trend is down but stretched; bounce risk`, color: T.watch, fast, slow, r };
  }
  if (trendUp) {
    return { status: "buy", label: "Bullish", reason: `${SMA_FAST}-tick avg above ${SMA_SLOW}-tick avg`, color: T.buy, fast, slow, r };
  }
  if (trendDown) {
    return { status: "sell", label: "Bearish", reason: `${SMA_FAST}-tick avg below ${SMA_SLOW}-tick avg`, color: T.sell, fast, slow, r };
  }
  return { status: "hold", label: "Neutral", reason: "No clear trend", color: T.hold, fast, slow, r };
}

// ---------- fetchers ----------
async function fetchPrice(asset) {
  if (asset.src === "gold-api") {
    const res = await fetch(`https://api.gold-api.com/price/${asset.symbol}`);
    if (!res.ok) throw new Error("fetch failed");
    const data = await res.json();
    return data.price;
  }
  if (asset.src === "frankfurter") {
    const res = await fetch(`https://api.frankfurter.dev/v2/rate/${asset.base}/${asset.quote}`);
    if (!res.ok) throw new Error("fetch failed");
    const data = await res.json();
    return data.rate;
  }
  throw new Error("unknown source");
}

function formatPrice(id, val) {
  if (val == null) return "—";
  if (id === "XAU" || id === "BTC") return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (id === "USDJPY") return val.toFixed(3);
  return val.toFixed(4);
}

// ---------- signal badge ----------
function Badge({ signal }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontFamily: T.sans,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: signal.color,
          border: `1px solid ${signal.color}`,
          borderRadius: 4,
          padding: "3px 8px",
        }}
      >
        {signal.label}
      </span>
      <span style={{ fontFamily: T.sans, fontSize: 12, color: T.textSecondary }}>{signal.reason}</span>
    </div>
  );
}

// ---------- instrument card ----------
function AssetCard({ asset, history, latest, prevLatest, error }) {
  const prices = history.map((h) => h.price);
  const signal = computeSignal(prices);
  const change = latest != null && prevLatest != null ? latest - prevLatest : null;
  const changePct = change != null && prevLatest ? (change / prevLatest) * 100 : null;

  const bbSeries = computeBollingerSeries(prices);
  const chartData = bbSeries.slice(-CHART_WINDOW);
  const hasBands = prices.length >= BB_PERIOD;
  const pointsUntilBands = BB_PERIOD - prices.length;

  return (
    <div
      style={{
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontFamily: T.serif, fontSize: 15, color: T.textPrimary }}>{asset.label}</div>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, letterSpacing: "0.04em" }}>{asset.pair}</div>
        </div>
        <span style={{ fontFamily: T.sans, fontSize: 10, color: T.brassDim, border: `1px solid ${T.border}`, borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap" }}>
          {asset.freshness}
        </span>
      </div>

      {error ? (
        <div style={{ fontFamily: T.sans, fontSize: 12, color: T.sell }}>Couldn't fetch this price. Will retry next cycle.</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontFamily: T.mono, fontSize: 15, color: T.textPrimary }}>
              {formatPrice(asset.id, latest)} <span style={{ fontSize: 10, color: T.textMuted }}>{asset.quote}</span>
            </div>
            {changePct != null && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: change >= 0 ? T.buy : T.sell }}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(changePct).toFixed(3)}%
              </div>
            )}
          </div>

          <div style={{ height: 150 }}>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <YAxis hide domain={["auto", "auto"]} />
                  <Line type="monotone" dataKey="upperOuter" stroke={T.brassDim} strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="upperInner" stroke={T.hold} strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="mid" stroke={T.textMuted} strokeWidth={1} strokeDasharray="2 3" dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="lowerInner" stroke={T.hold} strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="lowerOuter" stroke={T.brassDim} strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="price" stroke={T.brass} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ fontFamily: T.sans, fontSize: 11, color: T.textMuted, paddingTop: 60, textAlign: "center" }}>Gathering ticks for chart…</div>
            )}
            {!hasBands && chartData.length > 1 && (
              <div style={{ fontFamily: T.sans, fontSize: 10, color: T.textMuted, marginTop: -6, textAlign: "right" }}>
                Bollinger bands need {pointsUntilBands} more reading{pointsUntilBands === 1 ? "" : "s"}
              </div>
            )}
          </div>

          <Badge signal={signal} />

          <div style={{ display: "flex", gap: 14, fontFamily: T.mono, fontSize: 11, color: T.textSecondary, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
            <span>SMA{SMA_FAST} {signal.fast != null ? formatPrice(asset.id, signal.fast) : "—"}</span>
            <span>SMA{SMA_SLOW} {signal.slow != null ? formatPrice(asset.id, signal.slow) : "—"}</span>
            <span>RSI{RSI_PERIOD} {signal.r != null ? signal.r.toFixed(0) : "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- ticker marquee ----------
function Ticker({ items }) {
  const content = items.length ? items : ASSETS.map((a) => ({ label: a.label, val: "…" }));
  const row = content.map((c, i) => (
    <span key={i} style={{ marginRight: 40, fontFamily: T.mono, fontSize: 12, color: T.textSecondary, whiteSpace: "nowrap" }}>
      <span style={{ color: T.brass }}>{c.label}</span> {c.val}
    </span>
  ));
  return (
    <div style={{ overflow: "hidden", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: T.panelAlt, padding: "8px 0" }}>
      <div className="marquee-track" style={{ display: "flex", width: "max-content" }}>
        <div style={{ display: "flex" }}>{row}</div>
        <div style={{ display: "flex" }}>{row}</div>
      </div>
    </div>
  );
}

// ---------- main app ----------
export default function MarketSignalBoard() {
  const [history, setHistory] = useState({});
  const [errors, setErrors] = useState({});
  const [lastSync, setLastSync] = useState(null);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // load persisted history once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        setHistory(JSON.parse(raw));
      }
    } catch (e) {
      // no saved history yet
    }
    setLoaded(true);
  }, []);

  const runCycle = useCallback(async (currentHistory) => {
    setSyncing(true);
    const results = await Promise.all(
      ASSETS.map(async (asset) => {
        try {
          const price = await fetchPrice(asset);
          return { id: asset.id, price, ok: true };
        } catch (e) {
          return { id: asset.id, ok: false };
        }
      })
    );

    const nextHistory = { ...currentHistory };
    const nextErrors = {};
    const tickerItems = [];
    const now = Date.now();

    results.forEach((r) => {
      const asset = ASSETS.find((a) => a.id === r.id);
      if (r.ok) {
        const arr = nextHistory[r.id] ? [...nextHistory[r.id]] : [];
        arr.push({ t: now, price: r.price });
        if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
        nextHistory[r.id] = arr;
        tickerItems.push({ label: asset.pair, val: `${formatPrice(r.id, r.price)} ${asset.quote}` });
      } else {
        nextErrors[r.id] = true;
        const prevArr = nextHistory[r.id];
        const lastVal = prevArr && prevArr.length ? prevArr[prevArr.length - 1].price : null;
        tickerItems.push({ label: asset.pair, val: lastVal != null ? `${formatPrice(r.id, lastVal)} ${asset.quote} (stale)` : "—" });
      }
    });

    setHistory(nextHistory);
    setErrors(nextErrors);
    setLastSync(now);
    setSyncing(false);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextHistory));
    } catch (e) {
      // storage save failed, non-fatal
    }
    return nextHistory;
  }, []);

  // polling loop
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let currentHistory = history;

    const tick = async () => {
      if (cancelled || pausedRef.current) return;
      currentHistory = await runCycle(currentHistory);
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const handleManualRefresh = () => {
    if (!syncing) runCycle(history);
  };

  const handleClear = () => {
    setHistory({});
    setErrors({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  };

  const tickerItems = ASSETS.map((a) => {
    const arr = history[a.id];
    const last = arr && arr.length ? arr[arr.length - 1].price : null;
    return { label: a.pair, val: last != null ? `${formatPrice(a.id, last)} ${a.quote}` : "…" };
  });

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.textPrimary, fontFamily: T.sans }}>
      <style>{`
        @keyframes marquee-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .marquee-track { animation: marquee-scroll 40s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .marquee-track { animation: none; }
        }
        .grid-cards {
          display: grid;
          grid-template-columns: 1fr;
          gap: 14px;
        }
        @media (min-width: 640px) {
          .grid-cards { grid-template-columns: 1fr 1fr; }
        }
        @media (min-width: 1000px) {
          .grid-cards { grid-template-columns: 1fr 1fr 1fr; }
        }
        button:focus-visible {
          outline: 2px solid #C9A961;
          outline-offset: 2px;
        }
      `}</style>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 60px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: T.serif, fontSize: 26, letterSpacing: "0.01em" }}>Market Signal Board</div>
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.textSecondary, marginTop: 4 }}>
              Gold · Bitcoin · Forex majors — alerts only, nothing trades automatically
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
              {lastSync ? `synced ${new Date(lastSync).toLocaleTimeString()}` : "not synced yet"}
            </span>
            <button
              onClick={handleManualRefresh}
              disabled={syncing}
              style={{
                fontFamily: T.sans, fontSize: 12, fontWeight: 600, color: T.bg, background: T.brass,
                border: "none", borderRadius: 6, padding: "7px 12px", cursor: syncing ? "default" : "pointer", opacity: syncing ? 0.6 : 1,
              }}
            >
              {syncing ? "Syncing…" : "Refresh now"}
            </button>
            <button
              onClick={() => setPaused((p) => !p)}
              style={{
                fontFamily: T.sans, fontSize: 12, fontWeight: 600, color: T.textPrimary, background: "transparent",
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 12px", cursor: "pointer",
              }}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
      </div>

      <Ticker items={tickerItems} />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "22px 20px 0" }}>
        <div className="grid-cards">
          {ASSETS.map((asset) => {
            const arr = history[asset.id] || [];
            const latest = arr.length ? arr[arr.length - 1].price : null;
            const prevLatest = arr.length > 1 ? arr[arr.length - 2].price : null;
            return (
              <AssetCard
                key={asset.id}
                asset={asset}
                history={arr}
                latest={latest}
                prevLatest={prevLatest}
                error={!!errors[asset.id]}
              />
            );
          })}
        </div>

        <div style={{ marginTop: 26, borderTop: `1px solid ${T.border}`, paddingTop: 16, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontFamily: T.sans, fontSize: 11, color: T.textMuted, maxWidth: 640, lineHeight: 1.5 }}>
            Signals combine a {SMA_FAST}/{SMA_SLOW}-tick moving average crossover with 14-tick RSI, built from prices this board has collected itself —
            they get more reliable the longer this stays open. Forex majors use daily reference rates; gold and Bitcoin refresh live.
            This is not financial advice, and nothing here places trades on your behalf.
          </div>
          <button
            onClick={handleClear}
            style={{ fontFamily: T.sans, fontSize: 11, color: T.textMuted, background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer", height: "fit-content" }}
          >
            Clear collected history
          </button>
        </div>
      </div>
    </div>
  );
}
