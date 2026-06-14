import dns from 'dns';
dns.setDefaultResultOrder('ipv4first'); // Render free tier has no IPv6 egress

import { RSI } from 'technicalindicators';
import { Candle } from './fetcher';
import { computeIndicators, computeSupertrend, IndicatorResult, SupertrendPoint } from './indicators';
import { detectPatterns, PatternResult } from './patterns';
import { generateSignal, SignalResult } from './signals';
import { PaperTrader, Trade } from './paper-trader';
import { broadcastFull, broadcastSummary, setStateGetter, startServer } from './server';
import { startCombinedStream } from './stream';
import { onPriceUpdate } from './futures';
import { initDb } from './db';

export const COINS = [
  'BTCUSDT',  'ETHUSDT',  'BNBUSDT',  'SOLUSDT',  'XRPUSDT',
  'ADAUSDT',  'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT',  'MATICUSDT',
  'LINKUSDT', 'LTCUSDT',  'UNIUSDT',  'ATOMUSDT', 'NEARUSDT',
  'APTUSDT',  'ARBUSDT',  'OPUSDT',   'INJUSDT',  'SUIUSDT',
];

export const INTERVALS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d'];

// Higher timeframe used for trend bias on each trading timeframe (~4–5× higher).
const HIGHER_TF: Record<string, string> = {
  '1m':'15m','3m':'30m','5m':'1h','15m':'1h','30m':'4h',
  '1h':'4h','2h':'12h','4h':'1d','6h':'1d','12h':'1d','1d':'1d',
};

const CONFIG = { initialBalance: 10_000, port: parseInt(process.env.PORT || '3000'), broadcastMs: 400 };

interface SignalMarker { time: number; type: 'BUY'|'SELL'; price: number; }

interface PairState {
  symbol: string; interval: string;
  candles: Candle[]; ind: IndicatorResult; sig: SignalResult;
  supertrend: SupertrendPoint[];
  patterns: PatternResult[];
  trader: PaperTrader; signalMarkers: SignalMarker[];
  lastTrade: Trade|null; tickCount: number;
  timer: ReturnType<typeof setTimeout>|null;
  isLive: boolean;
}

const states = new Map<string, PairState>();
const pairKey = (s: string, i: string) => `${s}:${i}`;

function toChartCandles(candles: Candle[]) {
  return candles.map(c => ({ time: Math.floor(c.openTime/1000), open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume }));
}
function buildRsiSeries(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const vals   = RSI.calculate({ values: closes, period: 14 });
  const offset = closes.length - vals.length;
  return vals.map((v,i) => ({ time: Math.floor(candles[offset+i].openTime/1000), value: v }));
}

function buildPayload(s: PairState) {
  const price = s.candles.at(-1)?.close ?? 0;
  const st    = s.trader.getState(price);
  return {
    price,
    candles:        toChartCandles(s.candles),
    rsiSeries:      buildRsiSeries(s.candles),
    supertrendSeries: s.supertrend,
    patternMarkers:   s.patterns,
    signalMarkers:  [...s.signalMarkers],
    ind: s.ind, sig: s.sig,
    portfolioValue: st.portfolioValue, usdtBalance: st.usdtBalance,
    position:       st.position, trades: st.trades.slice(-20),
    lastTrade:      s.lastTrade, tickCount: s.tickCount,
    timestamp:      new Date().toISOString(),
  };
}

function scheduleBroadcast(s: PairState) {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    broadcastFull(s.symbol, s.interval, buildPayload(s));
    // 1m summary updates every coin's tab bar + futures engine mark price (live only)
    if (s.interval === '1m') {
      const price = s.candles.at(-1)?.close ?? 0;
      broadcastSummary(s.symbol, price, s.sig);
      if (s.isLive) onPriceUpdate(s.symbol, price).catch(e => console.error('[onPriceUpdate]', e));
    }
  }, CONFIG.broadcastMs);
}

async function main() {
  await initDb(); // ensure Postgres schema exists before serving
  startServer(CONFIG.port);

  // Register state getter so server can immediately respond to subscribe requests
  setStateGetter((symbol, interval) => {
    const s = states.get(pairKey(symbol, interval));
    if (!s || !s.candles.length) return null;
    return buildPayload(s);
  });

  const pairs: { symbol: string; interval: string }[] = [];
  for (const symbol of COINS)
    for (const interval of INTERVALS) {
      pairs.push({ symbol, interval });
      states.set(pairKey(symbol, interval), {
        symbol, interval, candles: [], ind: {} as IndicatorResult,
        sig: { signal: 'HOLD', confidence: 0, reasons: [] },
        supertrend: [], patterns: [],
        trader: new PaperTrader(CONFIG.initialBalance),
        signalMarkers: [], lastTrade: null, tickCount: 0, timer: null, isLive: false,
      });
    }

  console.log(`  Coins    : ${COINS.length}  (${COINS.join(', ')})`);
  console.log(`  Pairs    : ${pairs.length}  (${COINS.length} coins × ${INTERVALS.length} timeframes)`);
  console.log(`  Balance  : $${CONFIG.initialBalance.toLocaleString()} USDT per pair\n`);

  await startCombinedStream(pairs, ({ symbol, interval, candles, isClosed, isLive }) => {
    const s = states.get(pairKey(symbol, interval));
    if (!s) return;

    s.candles = candles;
    s.isLive  = isLive;
    const closes = candles.map(c => c.close);
    const price  = closes.at(-1)!;

    // The signal is computed on CLOSED candles only. The last element is the still-forming
    // candle until it closes, so we drop it (except on the tick it closes) — this stops the
    // BUY/SELL badge from repainting tick-by-tick within a single candle.
    const closedCloses = isClosed ? closes : closes.slice(0, -1);
    s.ind = computeIndicators(closedCloses);
    s.supertrend = computeSupertrend(s.candles);
    s.patterns   = detectPatterns(s.candles);

    // ── Signal context: regime gate, higher-TF bias, volume confirmation ──
    // Use the last CLOSED Supertrend point (the last array element tracks the forming candle).
    const stPoint = isClosed ? s.supertrend.at(-1) : s.supertrend.at(-2);
    const regime: 'bull'|'bear'|null = stPoint ? (stPoint.bull ? 'bull' : 'bear') : null;

    let higherTrend: 'bull'|'bear'|null = null;
    const higherTf = HIGHER_TF[interval];
    if (higherTf && higherTf !== interval) {
      const hp = states.get(pairKey(symbol, higherTf))?.supertrend.at(-1);
      if (hp) higherTrend = hp.bull ? 'bull' : 'bear';
    }

    // Volume confirmation: signal candle volume vs the trailing 20-candle average.
    const closedCandles = isClosed ? candles : candles.slice(0, -1);
    let volumeConfirmed = true;
    if (closedCandles.length >= 21) {
      const recent = closedCandles.slice(-21, -1);
      const avgVol = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
      volumeConfirmed = avgVol === 0 ? true : closedCandles.at(-1)!.volume >= 0.8 * avgVol;
    }

    s.sig = generateSignal(s.ind, { regime, higherTrend, volumeConfirmed });

    const recordTrade = (t: Trade) => {
      s.lastTrade = t;
      s.signalMarkers.push({ time: Math.floor(candles.at(-1)!.openTime/1000), type: t.type, price: t.price });
      if (s.signalMarkers.length > 500) s.signalMarkers.splice(0, s.signalMarkers.length - 500);
      const pnl = t.pnl !== undefined ? `  PnL $${t.pnl.toFixed(2)}` : '';
      const tag = t.reason ? ` (${t.reason})` : '';
      console.log(`[${new Date().toLocaleTimeString()}] ${symbol} ${interval}  ${t.type}${tag} @ $${price.toFixed(4)}${pnl}`);
    };

    // Risk management runs every tick: enforce stop-loss / take-profit at the live price.
    const exit = s.trader.checkStops(price);
    if (exit) recordTrade(exit);

    if (isClosed) {
      s.tickCount++;
      const executed: Trade[] =
        s.sig.signal === 'BUY'  ? s.trader.buy(price) :
        s.sig.signal === 'SELL' ? s.trader.sell(price) : [];
      for (const t of executed) recordTrade(t);
    }

    scheduleBroadcast(s);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
