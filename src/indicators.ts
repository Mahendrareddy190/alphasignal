import { RSI, MACD, EMA } from 'technicalindicators';

export interface SupertrendPoint {
  time: number;   // unix seconds
  value: number;  // line value (lower band when bull, upper band when bear)
  bull: boolean;  // true = uptrend (green), false = downtrend (red)
}

export function computeSupertrend(
  candles: Array<{ high: number; low: number; close: number; openTime: number }>,
  period = 10,
  mult = 3.0,
): SupertrendPoint[] {
  const n = candles.length;
  if (n < period + 1) return [];

  // True Range — tr[0] unused, tr[i] corresponds to candles[i]
  const tr: number[] = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder ATR — seed with SMA of tr[1..period], then Wilder smooth
  const atr: number[] = new Array(n).fill(0);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

  const result: SupertrendPoint[] = [];
  let finalUpper = 0, finalLower = 0, bull = true;

  for (let i = period; i < n; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + mult * atr[i];
    const basicLower = hl2 - mult * atr[i];

    let newUpper: number, newLower: number;
    if (i === period) {
      newUpper = basicUpper;
      newLower = basicLower;
    } else {
      const pc = candles[i - 1].close;
      newUpper = (basicUpper < finalUpper || pc > finalUpper) ? basicUpper : finalUpper;
      newLower = (basicLower > finalLower || pc < finalLower) ? basicLower : finalLower;
    }

    const newBull: boolean = i === period
      ? c.close > newLower
      : bull ? c.close >= newLower : c.close > newUpper;

    finalUpper = newUpper;
    finalLower = newLower;
    bull = newBull;

    result.push({ time: Math.floor(c.openTime / 1000), value: bull ? finalLower : finalUpper, bull });
  }

  return result;
}

export interface IndicatorResult {
  rsi: number | null;
  macdValue: number | null;
  macdHistogram: number | null;
  macdSignal: 'bullish' | 'bearish' | 'neutral';
  ema9: number | null;
  ema21: number | null;
  emaSignal: 'bullish' | 'bearish' | 'neutral';
}

export function computeIndicators(closes: number[]): IndicatorResult {
  // RSI(14)
  const rsiSeries = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiSeries.at(-1) ?? null;

  // MACD(12, 26, 9)
  const macdSeries = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const last = macdSeries.at(-1) ?? null;
  const prev = macdSeries.at(-2) ?? null;

  const macdValue = last?.MACD ?? null;
  const macdHistogram = last?.histogram ?? null;

  // MACD votes on histogram sign: positive = bullish momentum, negative = bearish.
  // This gives a vote every candle so the 2-of-3 threshold can be reached regularly.
  let macdSignal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (macdHistogram !== null) {
    if (macdHistogram > 0) macdSignal = 'bullish';
    else if (macdHistogram < 0) macdSignal = 'bearish';
  }

  // EMA(9) vs EMA(21) with a neutral deadzone — EMAs closer than EMA_NEUTRAL_BAND
  // count as flat, so a noisy near-touch no longer forces a directional vote.
  const ema9Series = EMA.calculate({ values: closes, period: 9 });
  const ema21Series = EMA.calculate({ values: closes, period: 21 });
  const ema9 = ema9Series.at(-1) ?? null;
  const ema21 = ema21Series.at(-1) ?? null;

  const EMA_NEUTRAL_BAND = 0.001; // 0.1%
  let emaSignal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (ema9 !== null && ema21 !== null && ema21 !== 0) {
    const gap = (ema9 - ema21) / ema21;
    if (gap > EMA_NEUTRAL_BAND) emaSignal = 'bullish';
    else if (gap < -EMA_NEUTRAL_BAND) emaSignal = 'bearish';
  }

  return { rsi, macdValue, macdHistogram, macdSignal, ema9, ema21, emaSignal };
}
