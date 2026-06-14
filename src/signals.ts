import { IndicatorResult } from './indicators';

export type Signal = 'BUY' | 'SELL' | 'HOLD';

export interface SignalResult {
  signal: Signal;
  confidence: number; // 0–100
  reasons: string[];
}

export interface SignalContext {
  regime?: 'bull' | 'bear' | null;       // current-timeframe Supertrend direction
  higherTrend?: 'bull' | 'bear' | null;  // higher-timeframe Supertrend direction
  volumeConfirmed?: boolean;             // signal candle volume vs its trailing average
}

export function generateSignal(ind: IndicatorResult, ctx: SignalContext = {}): SignalResult {
  let bullish = 0;
  let bearish = 0;
  const reasons: string[] = [];

  // RSI as a trend-timing filter aligned with EMA direction:
  // Below 50 in uptrend = pullback entry (bullish); above 50 in downtrend = bounce entry (bearish).
  // RSI reading AGAINST the EMA direction casts no vote — prevents knife-catching.
  if (ind.rsi !== null) {
    if (ind.rsi < 50 && ind.emaSignal === 'bullish') {
      bullish++;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} pullback in uptrend`);
    } else if (ind.rsi > 50 && ind.emaSignal === 'bearish') {
      bearish++;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} bounce in downtrend`);
    } else {
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — neutral`);
    }
  }

  // MACD signal-line crossover
  if (ind.macdSignal === 'bullish') {
    bullish++;
    reasons.push(`MACD bullish crossover (${ind.macdHistogram?.toFixed(4)})`);
  } else if (ind.macdSignal === 'bearish') {
    bearish++;
    reasons.push(`MACD bearish crossover (${ind.macdHistogram?.toFixed(4)})`);
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
  let signal: Signal =
    bullish >= 2 && bullish > bearish ? 'BUY'
    : bearish >= 2 && bearish > bullish ? 'SELL'
    : 'HOLD';

  // Regime gate — don't trade against the current-timeframe Supertrend trend.
  if (signal === 'BUY' && ctx.regime === 'bear') { signal = 'HOLD'; reasons.push('vetoed: bearish regime'); }
  else if (signal === 'SELL' && ctx.regime === 'bull') { signal = 'HOLD'; reasons.push('vetoed: bullish regime'); }

  // Higher-timeframe bias — don't fight the bigger trend.
  if (signal === 'BUY' && ctx.higherTrend === 'bear') { signal = 'HOLD'; reasons.push('vetoed: higher TF down'); }
  else if (signal === 'SELL' && ctx.higherTrend === 'bull') { signal = 'HOLD'; reasons.push('vetoed: higher TF up'); }

  // Volume confirmation — a breakout on weak volume is suspect.
  if (signal !== 'HOLD' && ctx.volumeConfirmed === false) { signal = 'HOLD'; reasons.push('vetoed: weak volume'); }

  // Confidence = net agreement (winning votes minus dissent), 0 when holding.
  const conviction = Math.max(bullish, bearish) - Math.min(bullish, bearish);
  const confidence = signal === 'HOLD' ? 0 : Math.round((conviction / 3) * 100);

  return { signal, confidence, reasons };
}
