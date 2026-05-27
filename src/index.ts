import { RSI } from 'technicalindicators';
import { Candle } from './fetcher';
import { computeIndicators, computeSupertrend, IndicatorResult, SupertrendPoint } from './indicators';
import { detectPatterns, PatternResult } from './patterns';
import { generateSignal, SignalResult } from './signals';
import { PaperTrader, Trade } from './paper-trader';
import { broadcastFull, broadcastSummary, setStateGetter, startServer } from './server';
import { startCombinedStream } from './stream';
import { onPriceUpdate } from './futures';

export const COINS = [
  'BTCUSDT',  'ETHUSDT',  'BNBUSDT',  'SOLUSDT',  'XRPUSDT',
  'ADAUSDT',  'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT',  'MATICUSDT',
  'LINKUSDT', 'LTCUSDT',  'UNIUSDT',  'ATOMUSDT', 'NEARUSDT',
  'APTUSDT',  'ARBUSDT',  'OPUSDT',   'INJUSDT',  'SUIUSDT',
];

export const INTERVALS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d'];

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
      if (s.isLive) onPriceUpdate(s.symbol, price);
    }
  }, CONFIG.broadcastMs);
}

async function main() {
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

    s.ind = computeIndicators(closes);
    s.sig = generateSignal(s.ind);
    s.supertrend = computeSupertrend(s.candles);
    s.patterns   = detectPatterns(s.candles);

    if (isClosed) {
      s.tickCount++;
      let executed: Trade|null = null;
      if (s.sig.signal === 'BUY')  executed = s.trader.buy(price);
      if (s.sig.signal === 'SELL') executed = s.trader.sell(price);
      if (executed) {
        s.lastTrade = executed;
        s.signalMarkers.push({ time: Math.floor(candles.at(-1)!.openTime/1000), type: executed.type, price: executed.price });
        const pnl = executed.pnl !== undefined ? `  PnL $${executed.pnl.toFixed(2)}` : '';
        console.log(`[${new Date().toLocaleTimeString()}] ${symbol} ${interval}  ${executed.type} @ $${price.toFixed(4)}${pnl}`);
      }
    }

    scheduleBroadcast(s);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
