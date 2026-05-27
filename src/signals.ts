import { IndicatorResult } from './indicators';

export type Signal = 'BUY' | 'SELL' | 'HOLD';

export interface SignalResult {
  signal: Signal;
  confidence: number; // 0–100
  reasons: string[];
}

export function generateSignal(ind: IndicatorResult): SignalResult {
  let bullish = 0;
  let bearish = 0;
  const reasons: string[] = [];

  // RSI: <30 oversold = bullish, >70 overbought = bearish
  if (ind.rsi !== null) {
    if (ind.rsi < 30) {
      bullish++;
      reasons.push(`RSI oversold @ ${ind.rsi.toFixed(1)}`);
    } else if (ind.rsi > 70) {
      bearish++;
      reasons.push(`RSI overbought @ ${ind.rsi.toFixed(1)}`);
    } else {
      reasons.push(`RSI neutral @ ${ind.rsi.toFixed(1)}`);
    }
  }

  // MACD histogram direction
  if (ind.macdSignal === 'bullish') {
    bullish++;
    reasons.push(`MACD histogram positive (${ind.macdHistogram?.toFixed(4)})`);
  } else if (ind.macdSignal === 'bearish') {
    bearish++;
    reasons.push(`MACD histogram negative (${ind.macdHistogram?.toFixed(4)})`);
  }

  // EMA crossover
  if (ind.emaSignal === 'bullish') {
    bullish++;
    reasons.push(`EMA9 ${ind.ema9?.toFixed(2)} > EMA21 ${ind.ema21?.toFixed(2)}`);
  } else if (ind.emaSignal === 'bearish') {
    bearish++;
    reasons.push(`EMA9 ${ind.ema9?.toFixed(2)} < EMA21 ${ind.ema21?.toFixed(2)}`);
  }

  // Require 2-of-3 agreement for a signal
  const signal: Signal =
    bullish >= 2 && bullish > bearish ? 'BUY'
    : bearish >= 2 && bearish > bullish ? 'SELL'
    : 'HOLD';

  const confidence = Math.round((Math.max(bullish, bearish) / 3) * 100);

  return { signal, confidence, reasons };
}
