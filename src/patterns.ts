import { Candle } from './fetcher';

export interface PatternKeyPoint {
  time: number;   // unix seconds
  price: number;
}

export interface PatternResult {
  time: number;
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  category: 'candlestick' | 'reversal' | 'continuation' | 'volatility';
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  keyPoints?: PatternKeyPoint[];
  neckline?: number;
  trendLines?: [PatternKeyPoint, PatternKeyPoint][];
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface SwingPt { idx: number; price: number; }

function swingHighs(candles: Candle[], w = 3, lookback = 80): SwingPt[] {
  const out: SwingPt[] = [];
  const start = Math.max(w, candles.length - lookback - w);
  for (let i = start; i < candles.length - w; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i && candles[j] && candles[j].high >= candles[i].high) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: candles[i].high });
  }
  return out;
}

function swingLows(candles: Candle[], w = 3, lookback = 80): SwingPt[] {
  const out: SwingPt[] = [];
  const start = Math.max(w, candles.length - lookback - w);
  for (let i = start; i < candles.length - w; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i && candles[j] && candles[j].low <= candles[i].low) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: candles[i].low });
  }
  return out;
}

function slope(vals: number[]): number {
  const n = vals.length;
  const mx = (n - 1) / 2;
  const my = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (vals[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function normSlope(candles: Candle[], selector: (c: Candle) => number, window: number): number {
  const sl = candles.slice(-window);
  const avg = sl.reduce((s, c) => s + selector(c), 0) / sl.length;
  return avg === 0 ? 0 : slope(sl.map(selector)) / avg;
}

function t(c: Candle) { return Math.floor(c.openTime / 1000); }

function minIdxIn(candles: Candle[], from: number, to: number): number {
  let idx = from, val = candles[from].low;
  for (let k = from + 1; k <= to; k++) {
    if (candles[k].low < val) { val = candles[k].low; idx = k; }
  }
  return idx;
}

function maxIdxIn(candles: Candle[], from: number, to: number): number {
  let idx = from, val = candles[from].high;
  for (let k = from + 1; k <= to; k++) {
    if (candles[k].high > val) { val = candles[k].high; idx = k; }
  }
  return idx;
}

function trendLine(
  window: Candle[],
  sel: (c: Candle) => number,
): [PatternKeyPoint, PatternKeyPoint] {
  const n = window.length;
  const vals = window.map(sel);
  const avg = vals.reduce((a, b) => a + b, 0) / n;
  const s = slope(vals);
  return [
    { time: t(window[0]),     price: avg - s * (n - 1) / 2 },
    { time: t(window[n - 1]), price: avg + s * (n - 1) / 2 },
  ];
}

// ── Candlestick Patterns (1–3 bars) ────────────────────────────────────────

function candlesticks(candles: Candle[]): PatternResult[] {
  const res: PatternResult[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2];
    const body0 = Math.abs(c0.close - c0.open), rng0 = c0.high - c0.low;
    const top0 = Math.max(c0.close, c0.open), bot0 = Math.min(c0.close, c0.open);
    const upW0 = c0.high - top0, dnW0 = bot0 - c0.low;
    const bull0 = c0.close >= c0.open;

    const body1 = Math.abs(c1.close - c1.open), rng1 = c1.high - c1.low;
    const top1 = Math.max(c1.close, c1.open), bot1 = Math.min(c1.close, c1.open);
    const bull1 = c1.close >= c1.open;

    const body2 = Math.abs(c2.close - c2.open), rng2 = c2.high - c2.low;
    const bull2 = c2.close >= c2.open;

    if (rng0 <= 0) continue;
    const tm = t(c0), tm1 = t(c1), tm2 = t(c2);
    const cat = 'candlestick' as const;

    const hi1 = Math.max(c0.high, c1.high), lo1 = Math.min(c0.low, c1.low);
    const hi2 = Math.max(c0.high, c1.high, c2.high), lo2 = Math.min(c0.low, c1.low, c2.low);

    // 1-bar patterns — keyPoints trace the wick+body shape
    const kp1 = (c: Candle): PatternKeyPoint[] => [
      { time: t(c), price: c.high },
      { time: t(c), price: Math.max(c.open, c.close) },
      { time: t(c), price: Math.min(c.open, c.close) },
      { time: t(c), price: c.low },
    ];

    if (body0 / rng0 < 0.1)
      res.push({ time: tm, name: 'Doji', type: 'neutral', category: cat,
        startTime: tm, endTime: tm, high: c0.high, low: c0.low, keyPoints: kp1(c0) });

    if (body0 > 0 && body0 / rng0 < 0.35 && dnW0 >= 2 * body0 && upW0 <= body0 * 0.5)
      res.push({ time: tm, name: 'Hammer', type: 'bullish', category: cat,
        startTime: tm, endTime: tm, high: c0.high, low: c0.low, keyPoints: kp1(c0) });

    if (body0 > 0 && body0 / rng0 < 0.35 && dnW0 >= 2 * body0 && upW0 <= body0 * 0.5 && bull1)
      res.push({ time: tm, name: 'Hanging Man', type: 'bearish', category: cat,
        startTime: tm, endTime: tm, high: c0.high, low: c0.low, keyPoints: kp1(c0) });

    if (body0 > 0 && body0 / rng0 < 0.35 && upW0 >= 2 * body0 && dnW0 <= body0 * 0.5 && !bull0)
      res.push({ time: tm, name: 'Shooting Star', type: 'bearish', category: cat,
        startTime: tm, endTime: tm, high: c0.high, low: c0.low, keyPoints: kp1(c0) });

    if (body0 > 0 && body0 / rng0 < 0.35 && upW0 >= 2 * body0 && dnW0 <= body0 * 0.5 && bull0)
      res.push({ time: tm, name: 'Inverted Hammer', type: 'bullish', category: cat,
        startTime: tm, endTime: tm, high: c0.high, low: c0.low, keyPoints: kp1(c0) });

    // 2-bar patterns — keyPoints connect high→close of bar1 → close→low of bar2 (engulf shape)
    if (!bull1 && bull0 && bot0 <= bot1 && top0 >= top1 && body0 > body1)
      res.push({ time: tm, name: 'Bullish Engulfing', type: 'bullish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1,
        keyPoints: [{ time: tm1, price: c1.open }, { time: tm1, price: c1.close },
                    { time: tm, price: c0.open },  { time: tm, price: c0.close }] });

    if (bull1 && !bull0 && top0 >= top1 && bot0 <= bot1 && body0 > body1)
      res.push({ time: tm, name: 'Bearish Engulfing', type: 'bearish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1,
        keyPoints: [{ time: tm1, price: c1.close }, { time: tm1, price: c1.open },
                    { time: tm, price: c0.close },  { time: tm, price: c0.open }] });

    if (bull1 && !bull0 && c0.open > c1.high && c0.close < (c1.open + c1.close) / 2 && body0 > 0)
      res.push({ time: tm, name: 'Dark Cloud Cover', type: 'bearish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1,
        keyPoints: [{ time: tm1, price: c1.close }, { time: tm, price: c0.open },
                    { time: tm, price: c0.close }] });

    if (!bull1 && bull0 && c0.open < c1.low && c0.close > (c1.open + c1.close) / 2 && body0 > 0)
      res.push({ time: tm, name: 'Piercing Line', type: 'bullish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1,
        keyPoints: [{ time: tm1, price: c1.close }, { time: tm, price: c0.open },
                    { time: tm, price: c0.close }] });

    if (!bull1 && bull0 && top0 < top1 && bot0 > bot1 && body0 < body1 * 0.5)
      res.push({ time: tm, name: 'Bullish Harami', type: 'bullish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1 });

    if (bull1 && !bull0 && top0 < top1 && bot0 > bot1 && body0 < body1 * 0.5)
      res.push({ time: tm, name: 'Bearish Harami', type: 'bearish', category: cat,
        startTime: tm1, endTime: tm, high: hi1, low: lo1 });

    // 3-bar patterns
    if (!bull2 && body1 < body2 * 0.4 && bull0 && c0.close > (c2.open + c2.close) / 2)
      res.push({ time: tm, name: 'Morning Star', type: 'bullish', category: cat,
        startTime: tm2, endTime: tm, high: hi2, low: lo2,
        keyPoints: [{ time: tm2, price: c2.open }, { time: tm2, price: c2.close },
                    { time: tm1, price: c1.low },
                    { time: tm, price: c0.open },  { time: tm, price: c0.close }] });

    if (bull2 && body1 < body2 * 0.4 && !bull0 && c0.close < (c2.open + c2.close) / 2)
      res.push({ time: tm, name: 'Evening Star', type: 'bearish', category: cat,
        startTime: tm2, endTime: tm, high: hi2, low: lo2,
        keyPoints: [{ time: tm2, price: c2.close }, { time: tm2, price: c2.open },
                    { time: tm1, price: c1.high },
                    { time: tm, price: c0.close }, { time: tm, price: c0.open }] });

    if (bull0 && bull1 && bull2 &&
        c0.close > c1.close && c1.close > c2.close &&
        body0 > rng0 * 0.5 && body1 > rng1 * 0.5 && rng2 > 0 && body2 > rng2 * 0.5)
      res.push({ time: tm, name: 'Three White Soldiers', type: 'bullish', category: cat,
        startTime: tm2, endTime: tm, high: hi2, low: lo2,
        keyPoints: [{ time: tm2, price: c2.open }, { time: tm2, price: c2.close },
                    { time: tm1, price: c1.open }, { time: tm1, price: c1.close },
                    { time: tm, price: c0.open },  { time: tm, price: c0.close }] });

    if (!bull0 && !bull1 && !bull2 &&
        c0.close < c1.close && c1.close < c2.close &&
        body0 > rng0 * 0.5 && body1 > rng1 * 0.5 && rng2 > 0 && body2 > rng2 * 0.5)
      res.push({ time: tm, name: 'Three Black Crows', type: 'bearish', category: cat,
        startTime: tm2, endTime: tm, high: hi2, low: lo2,
        keyPoints: [{ time: tm2, price: c2.close }, { time: tm2, price: c2.open },
                    { time: tm1, price: c1.close }, { time: tm1, price: c1.open },
                    { time: tm, price: c0.close },  { time: tm, price: c0.open }] });
  }

  return res;
}

// ── Reversal Patterns ──────────────────────────────────────────────────────

function reversals(candles: Candle[]): PatternResult[] {
  const res: PatternResult[] = [];
  if (candles.length < 20) return res;

  const highs = swingHighs(candles, 3, 100);
  const lows  = swingLows(candles, 3, 100);
  const cat   = 'reversal' as const;

  // ── Double Top ──
  for (let i = 1; i < highs.length; i++) {
    const h1 = highs[i - 1], h2 = highs[i];
    if (h2.idx - h1.idx < 5) continue;
    const pct = Math.abs(h1.price - h2.price) / ((h1.price + h2.price) / 2);
    if (pct > 0.025) continue;
    const neck = Math.min(...candles.slice(h1.idx, h2.idx + 1).map(c => c.low));
    if ((((h1.price + h2.price) / 2) - neck) / ((h1.price + h2.price) / 2) < 0.02) continue;
    const vIdx = minIdxIn(candles, h1.idx, h2.idx);
    for (let j = h2.idx + 1; j < candles.length; j++) {
      if (candles[j].close < neck) {
        res.push({ time: t(candles[j]), name: 'Double Top', type: 'bearish', category: cat,
          startTime: t(candles[h1.idx]), endTime: t(candles[j]),
          high: Math.max(h1.price, h2.price), low: neck,
          neckline: neck,
          keyPoints: [
            { time: t(candles[h1.idx]), price: h1.price },
            { time: t(candles[vIdx]),   price: candles[vIdx].low },
            { time: t(candles[h2.idx]), price: h2.price },
          ] });
        break;
      }
    }
  }

  // ── Double Bottom ──
  for (let i = 1; i < lows.length; i++) {
    const l1 = lows[i - 1], l2 = lows[i];
    if (l2.idx - l1.idx < 5) continue;
    const pct = Math.abs(l1.price - l2.price) / ((l1.price + l2.price) / 2);
    if (pct > 0.025) continue;
    const neck = Math.max(...candles.slice(l1.idx, l2.idx + 1).map(c => c.high));
    if ((neck - (l1.price + l2.price) / 2) / neck < 0.02) continue;
    const pIdx = maxIdxIn(candles, l1.idx, l2.idx);
    for (let j = l2.idx + 1; j < candles.length; j++) {
      if (candles[j].close > neck) {
        res.push({ time: t(candles[j]), name: 'Double Bottom', type: 'bullish', category: cat,
          startTime: t(candles[l1.idx]), endTime: t(candles[j]),
          high: neck, low: Math.min(l1.price, l2.price),
          neckline: neck,
          keyPoints: [
            { time: t(candles[l1.idx]), price: l1.price },
            { time: t(candles[pIdx]),   price: candles[pIdx].high },
            { time: t(candles[l2.idx]), price: l2.price },
          ] });
        break;
      }
    }
  }

  // ── Triple Top ──
  for (let i = 2; i < highs.length; i++) {
    const h1 = highs[i - 2], h2 = highs[i - 1], h3 = highs[i];
    if (h2.idx - h1.idx < 5 || h3.idx - h2.idx < 5) continue;
    const avg = (h1.price + h2.price + h3.price) / 3;
    if (Math.max(Math.abs(h1.price - avg), Math.abs(h2.price - avg), Math.abs(h3.price - avg)) / avg > 0.025) continue;
    const neck = Math.min(
      Math.min(...candles.slice(h1.idx, h2.idx + 1).map(c => c.low)),
      Math.min(...candles.slice(h2.idx, h3.idx + 1).map(c => c.low))
    );
    const v1Idx = minIdxIn(candles, h1.idx, h2.idx);
    const v2Idx = minIdxIn(candles, h2.idx, h3.idx);
    for (let j = h3.idx + 1; j < candles.length; j++) {
      if (candles[j].close < neck) {
        res.push({ time: t(candles[j]), name: 'Triple Top', type: 'bearish', category: cat,
          startTime: t(candles[h1.idx]), endTime: t(candles[j]),
          high: Math.max(h1.price, h2.price, h3.price), low: neck,
          neckline: neck,
          keyPoints: [
            { time: t(candles[h1.idx]), price: h1.price },
            { time: t(candles[v1Idx]),  price: candles[v1Idx].low },
            { time: t(candles[h2.idx]), price: h2.price },
            { time: t(candles[v2Idx]),  price: candles[v2Idx].low },
            { time: t(candles[h3.idx]), price: h3.price },
          ] });
        break;
      }
    }
  }

  // ── Triple Bottom ──
  for (let i = 2; i < lows.length; i++) {
    const l1 = lows[i - 2], l2 = lows[i - 1], l3 = lows[i];
    if (l2.idx - l1.idx < 5 || l3.idx - l2.idx < 5) continue;
    const avg = (l1.price + l2.price + l3.price) / 3;
    if (Math.max(Math.abs(l1.price - avg), Math.abs(l2.price - avg), Math.abs(l3.price - avg)) / avg > 0.025) continue;
    const neck = Math.max(
      Math.max(...candles.slice(l1.idx, l2.idx + 1).map(c => c.high)),
      Math.max(...candles.slice(l2.idx, l3.idx + 1).map(c => c.high))
    );
    const p1Idx = maxIdxIn(candles, l1.idx, l2.idx);
    const p2Idx = maxIdxIn(candles, l2.idx, l3.idx);
    for (let j = l3.idx + 1; j < candles.length; j++) {
      if (candles[j].close > neck) {
        res.push({ time: t(candles[j]), name: 'Triple Bottom', type: 'bullish', category: cat,
          startTime: t(candles[l1.idx]), endTime: t(candles[j]),
          high: neck, low: Math.min(l1.price, l2.price, l3.price),
          neckline: neck,
          keyPoints: [
            { time: t(candles[l1.idx]), price: l1.price },
            { time: t(candles[p1Idx]),  price: candles[p1Idx].high },
            { time: t(candles[l2.idx]), price: l2.price },
            { time: t(candles[p2Idx]),  price: candles[p2Idx].high },
            { time: t(candles[l3.idx]), price: l3.price },
          ] });
        break;
      }
    }
  }

  // ── Head and Shoulders Top ──
  for (let i = 2; i < highs.length; i++) {
    const ls = highs[i - 2], hd = highs[i - 1], rs = highs[i];
    if (hd.idx - ls.idx < 5 || rs.idx - hd.idx < 5) continue;
    if (hd.price <= ls.price || hd.price <= rs.price) continue;
    const shoulderDiff = Math.abs(ls.price - rs.price) / ((ls.price + rs.price) / 2);
    if (shoulderDiff > 0.04) continue;
    const t1low = Math.min(...candles.slice(ls.idx, hd.idx + 1).map(c => c.low));
    const t2low = Math.min(...candles.slice(hd.idx, rs.idx + 1).map(c => c.low));
    const neckline = (t1low + t2low) / 2;
    const v1Idx = minIdxIn(candles, ls.idx, hd.idx);
    const v2Idx = minIdxIn(candles, hd.idx, rs.idx);
    for (let j = rs.idx + 1; j < candles.length; j++) {
      if (candles[j].close < neckline) {
        res.push({ time: t(candles[j]), name: 'H&S Top', type: 'bearish', category: cat,
          startTime: t(candles[ls.idx]), endTime: t(candles[j]),
          high: hd.price, low: neckline,
          neckline,
          keyPoints: [
            { time: t(candles[ls.idx]), price: ls.price },
            { time: t(candles[v1Idx]),  price: candles[v1Idx].low },
            { time: t(candles[hd.idx]), price: hd.price },
            { time: t(candles[v2Idx]),  price: candles[v2Idx].low },
            { time: t(candles[rs.idx]), price: rs.price },
          ] });
        break;
      }
    }
  }

  // ── Head and Shoulders Bottom (Inverse) ──
  for (let i = 2; i < lows.length; i++) {
    const ls = lows[i - 2], hd = lows[i - 1], rs = lows[i];
    if (hd.idx - ls.idx < 5 || rs.idx - hd.idx < 5) continue;
    if (hd.price >= ls.price || hd.price >= rs.price) continue;
    const shoulderDiff = Math.abs(ls.price - rs.price) / ((ls.price + rs.price) / 2);
    if (shoulderDiff > 0.04) continue;
    const t1high = Math.max(...candles.slice(ls.idx, hd.idx + 1).map(c => c.high));
    const t2high = Math.max(...candles.slice(hd.idx, rs.idx + 1).map(c => c.high));
    const neckline = (t1high + t2high) / 2;
    const p1Idx = maxIdxIn(candles, ls.idx, hd.idx);
    const p2Idx = maxIdxIn(candles, hd.idx, rs.idx);
    for (let j = rs.idx + 1; j < candles.length; j++) {
      if (candles[j].close > neckline) {
        res.push({ time: t(candles[j]), name: 'H&S Bottom', type: 'bullish', category: cat,
          startTime: t(candles[ls.idx]), endTime: t(candles[j]),
          high: neckline, low: hd.price,
          neckline,
          keyPoints: [
            { time: t(candles[ls.idx]), price: ls.price },
            { time: t(candles[p1Idx]),  price: candles[p1Idx].high },
            { time: t(candles[hd.idx]), price: hd.price },
            { time: t(candles[p2Idx]),  price: candles[p2Idx].high },
            { time: t(candles[rs.idx]), price: rs.price },
          ] });
        break;
      }
    }
  }

  return res;
}

// ── Continuation Patterns ──────────────────────────────────────────────────

function continuations(candles: Candle[]): PatternResult[] {
  const res: PatternResult[] = [];
  if (candles.length < 20) return res;

  const last = candles[candles.length - 1];
  const tm   = t(last);
  const cat  = 'continuation' as const;

  // ── Triangles and Wedges (20-bar window) ──
  const W = Math.min(30, candles.length);
  const sl = candles.slice(-W);
  const slStart = t(sl[0]);
  const slHigh = Math.max(...sl.map(c => c.high));
  const slLow  = Math.min(...sl.map(c => c.low));

  const slopeH = normSlope(candles, c => c.high, W);
  const slopeL = normSlope(candles, c => c.low,  W);

  const firstRange = sl[0].high - sl[0].low;
  const lastRange  = last.high  - last.low;
  const converging = firstRange > 0 && lastRange < firstRange * 0.65;

  if (converging) {
    const threshold = 0.0002;
    const hFlat = Math.abs(slopeH) < threshold, lFlat = Math.abs(slopeL) < threshold;
    const hDown = slopeH < -threshold,           lUp   = slopeL > threshold;
    const hUp   = slopeH > threshold,            lDown = slopeL < -threshold;

    const upperLine = trendLine(sl, c => c.high);
    const lowerLine = trendLine(sl, c => c.low);
    const lines: [PatternKeyPoint, PatternKeyPoint][] = [upperLine, lowerLine];

    if (hDown && lUp)
      res.push({ time: tm, name: 'Symmetrical Triangle', type: 'neutral', category: cat,
        startTime: slStart, endTime: tm, high: slHigh, low: slLow, trendLines: lines });
    else if (hFlat && lUp)
      res.push({ time: tm, name: 'Ascending Triangle', type: 'bullish', category: cat,
        startTime: slStart, endTime: tm, high: slHigh, low: slLow, trendLines: lines });
    else if (lFlat && hDown)
      res.push({ time: tm, name: 'Descending Triangle', type: 'bearish', category: cat,
        startTime: slStart, endTime: tm, high: slHigh, low: slLow, trendLines: lines });
    else if (hUp && lUp && slopeL > slopeH * 1.2)
      res.push({ time: tm, name: 'Rising Wedge', type: 'bearish', category: cat,
        startTime: slStart, endTime: tm, high: slHigh, low: slLow, trendLines: lines });
    else if (hDown && lDown && slopeH < slopeL * 1.2)
      res.push({ time: tm, name: 'Falling Wedge', type: 'bullish', category: cat,
        startTime: slStart, endTime: tm, high: slHigh, low: slLow, trendLines: lines });
  }

  // ── Rectangle ──
  const RW = Math.min(40, candles.length);
  const rs = candles.slice(-RW);
  const bandH = Math.max(...rs.map(c => c.high));
  const bandL = Math.min(...rs.map(c => c.low));
  const bandMid = (bandH + bandL) / 2;
  if (bandMid > 0) {
    const bandWidth = (bandH - bandL) / bandMid;
    const topSlope  = Math.abs(normSlope(candles, c => c.high, RW));
    const botSlope  = Math.abs(normSlope(candles, c => c.low,  RW));
    if (bandWidth < 0.06 && topSlope < 0.0003 && botSlope < 0.0003) {
      const rectStart = t(rs[0]);
      const rectLines: [PatternKeyPoint, PatternKeyPoint][] = [
        [{ time: rectStart, price: bandH }, { time: tm, price: bandH }],
        [{ time: rectStart, price: bandL }, { time: tm, price: bandL }],
      ];
      if (last.close > bandH * 0.999)
        res.push({ time: tm, name: 'Rectangle Breakout ↑', type: 'bullish', category: cat,
          startTime: rectStart, endTime: tm, high: bandH, low: bandL, trendLines: rectLines });
      else if (last.close < bandL * 1.001)
        res.push({ time: tm, name: 'Rectangle Breakout ↓', type: 'bearish', category: cat,
          startTime: rectStart, endTime: tm, high: bandH, low: bandL, trendLines: rectLines });
    }
  }

  // ── Flag / Pennant ──
  const FP = 5, FC = 10;
  if (candles.length >= FP + FC) {
    const pole  = candles.slice(-FP - FC, -FC);
    const cons  = candles.slice(-FC);
    const poleMove = Math.abs(pole[pole.length - 1].close - pole[0].open) / pole[0].open;
    const consRange = (Math.max(...cons.map(c => c.high)) - Math.min(...cons.map(c => c.low))) /
                      Math.max(...cons.map(c => c.high));
    if (poleMove > 0.04 && consRange < 0.025) {
      const poleUp  = pole[pole.length - 1].close > pole[0].open;
      const allFlag = [...pole, ...cons];
      const flagH   = Math.max(...allFlag.map(c => c.high));
      const flagL   = Math.min(...allFlag.map(c => c.low));
      // Pole as keyPoints, flag channel as trendLines
      const poleKP: PatternKeyPoint[] = [
        { time: t(pole[0]),              price: poleUp ? pole[0].low  : pole[0].high },
        { time: t(pole[pole.length - 1]), price: poleUp ? pole[pole.length - 1].high : pole[pole.length - 1].low },
      ];
      const flagLines: [PatternKeyPoint, PatternKeyPoint][] = [
        trendLine(cons, c => c.high),
        trendLine(cons, c => c.low),
      ];
      res.push({ time: tm, name: poleUp ? 'Bull Flag' : 'Bear Flag',
        type: poleUp ? 'bullish' : 'bearish', category: cat,
        startTime: t(pole[0]), endTime: tm, high: flagH, low: flagL,
        keyPoints: poleKP, trendLines: flagLines });
    }
  }

  // ── Cup and Handle ──
  if (candles.length >= 40) {
    const CW = 40;
    const cup = candles.slice(-CW);
    const cupLeft  = cup[0].high;
    const cupRight = cup[cup.length - 1].close;
    const cupLow   = Math.min(...cup.map(c => c.low));
    const cupDepth = (((cupLeft + cupRight) / 2) - cupLow) / ((cupLeft + cupRight) / 2);
    const leftQuart  = cup.slice(0, 10);
    const rightQuart = cup.slice(30);
    const midHalf    = cup.slice(10, 30);
    const midLow     = Math.min(...midHalf.map(c => c.low));
    const isRounded  = midLow <= cupLow * 1.01 &&
      Math.min(...leftQuart.map(c => c.low)) > midLow * 1.03 &&
      Math.min(...rightQuart.map(c => c.low)) > midLow * 1.03;
    if (cupDepth > 0.05 && cupDepth < 0.35 && isRounded && cupRight > cupLeft * 0.97) {
      const cupH = Math.max(...cup.map(c => c.high));
      // Sample 9 points along the cup lows to trace the curve
      const step = Math.floor(CW / 8);
      const cupKP: PatternKeyPoint[] = [];
      for (let i = 0; i < CW; i += step) {
        const ci = cup[Math.min(i, CW - 1)];
        cupKP.push({ time: t(ci), price: ci.low });
      }
      cupKP.push({ time: t(cup[CW - 1]), price: cup[CW - 1].close });
      res.push({ time: tm, name: 'Cup & Handle', type: 'bullish', category: cat,
        startTime: t(cup[0]), endTime: tm, high: cupH, low: cupLow,
        keyPoints: cupKP });
    }
  }

  return res;
}

// ── Volatility / Short-Term Patterns ──────────────────────────────────────

function volatility(candles: Candle[]): PatternResult[] {
  const res: PatternResult[] = [];
  const cat = 'volatility' as const;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i], c1 = candles[i - 1];
    const tm = t(c0);

    if (c0.open > c1.high * 1.002)
      res.push({ time: tm, name: 'Gap Up', type: 'bullish', category: cat,
        startTime: t(c1), endTime: tm, high: Math.max(c0.high, c1.high), low: Math.min(c0.low, c1.low),
        keyPoints: [{ time: t(c1), price: c1.high }, { time: tm, price: c0.low }] });

    if (c0.open < c1.low * 0.998)
      res.push({ time: tm, name: 'Gap Down', type: 'bearish', category: cat,
        startTime: t(c1), endTime: tm, high: Math.max(c0.high, c1.high), low: Math.min(c0.low, c1.low),
        keyPoints: [{ time: t(c1), price: c1.low }, { time: tm, price: c0.high }] });

    if (c0.high < c1.high && c0.low > c1.low)
      res.push({ time: tm, name: 'Inside Bar', type: 'neutral', category: cat,
        startTime: t(c1), endTime: tm, high: c1.high, low: c1.low });

    const rng0 = c0.high - c0.low;
    const maxPrevRng = Math.max(...[1, 2, 3].map(k => candles[i - k].high - candles[i - k].low));
    if (rng0 < maxPrevRng * 0.7 && rng0 > 0) {
      const nr4Candles = [candles[i - 3], candles[i - 2], c1, c0];
      res.push({ time: tm, name: 'Narrow Range (NR4)', type: 'neutral', category: cat,
        startTime: t(candles[i - 3]), endTime: tm,
        high: Math.max(...nr4Candles.map(c => c.high)), low: Math.min(...nr4Candles.map(c => c.low)) });
    }

    if (i >= 1) {
      const rng1 = c1.high - c1.low;
      const prevClose = i >= 2 ? candles[i - 2].close : c1.open;
      if (rng0 > 0 && rng1 > 0 && rng0 > rng1 * 0.7 && rng1 > rng0 * 0.7 &&
          prevClose > c1.close && c0.close > c0.open + (c0.high - c0.open) * 0.3)
        res.push({ time: tm, name: 'Pipe Bottom', type: 'bullish', category: cat,
          startTime: t(c1), endTime: tm, high: Math.max(c0.high, c1.high), low: Math.min(c0.low, c1.low),
          keyPoints: [{ time: t(c1), price: c1.high }, { time: t(c1), price: c1.low },
                      { time: tm, price: c0.low }, { time: tm, price: c0.close }] });
    }

    if (i >= 1) {
      const rng1 = c1.high - c1.low;
      const prevClose = i >= 2 ? candles[i - 2].close : c1.open;
      if (rng0 > 0 && rng1 > 0 && rng0 > rng1 * 0.7 && rng1 > rng0 * 0.7 &&
          prevClose < c1.close && c0.close < c0.open - (c0.open - c0.low) * 0.3)
        res.push({ time: tm, name: 'Pipe Top', type: 'bearish', category: cat,
          startTime: t(c1), endTime: tm, high: Math.max(c0.high, c1.high), low: Math.min(c0.low, c1.low),
          keyPoints: [{ time: t(c1), price: c1.low }, { time: t(c1), price: c1.high },
                      { time: tm, price: c0.high }, { time: tm, price: c0.close }] });
    }
  }

  return res;
}

// ── Main export ────────────────────────────────────────────────────────────

export function detectPatterns(candles: Candle[]): PatternResult[] {
  return [
    ...candlesticks(candles),
    ...reversals(candles),
    ...continuations(candles),
    ...volatility(candles),
  ];
}
