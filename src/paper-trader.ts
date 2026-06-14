export type Side = 'LONG' | 'SHORT';

export interface Position {
  side: Side;
  entryPrice: number;
  quantity: number;
  entryTime: Date;
  stopPrice: number;
  targetPrice: number;
  entryFee: number;
}

export interface Trade {
  type: 'BUY' | 'SELL';
  side?: Side;   // side of the position this trade opened or closed
  price: number;
  quantity: number;
  time: Date;
  pnl?: number;  // net realized PnL on a close (includes entry + exit fees)
  reason?: 'signal' | 'stop' | 'target' | 'opposite';
}

export interface RiskConfig {
  riskPerTrade?: number; // fraction of equity lost if the stop is hit (default 1%)
  stopPct?: number;      // stop distance from entry as a fraction (default 2%)
  rr?: number;           // reward:risk multiple for the take-profit (default 2:1)
  feeRate?: number;      // taker fee charged per side (default 0.04%)
}

// Futures-style paper trader: long OR short, every entry carries a stop and target,
// size is scaled so a stop-out costs ~riskPerTrade of equity, and taker fees are charged.
// Accounting is mark-to-market: usdtBalance is realized cash, unrealized PnL is added on top.
export class PaperTrader {
  private usdtBalance: number;
  private position: Position | null = null;
  private trades: Trade[] = [];
  private readonly riskPerTrade: number;
  private readonly stopPct: number;
  private readonly rr: number;
  private readonly feeRate: number;

  constructor(initialBalance = 10_000, opts: RiskConfig = {}) {
    this.usdtBalance  = initialBalance;
    this.riskPerTrade = opts.riskPerTrade ?? 0.01;
    this.stopPct      = opts.stopPct ?? 0.02;
    this.rr           = opts.rr ?? 2;
    this.feeRate      = opts.feeRate ?? 0.0004;
  }

  // BUY signal: open a long when flat, or flip (cover short + open long immediately).
  buy(price: number): Trade[] {
    if (price <= 0) return [];
    if (!this.position) {
      const t = this.open('LONG', price);
      return t ? [t] : [];
    }
    if (this.position.side === 'SHORT') {
      const close = this.close(price, 'opposite');
      const open  = this.open('LONG', price);
      return open ? [close, open] : [close];
    }
    return []; // already long
  }

  // SELL signal: open a short when flat, or flip (close long + open short immediately).
  sell(price: number): Trade[] {
    if (price <= 0) return [];
    if (!this.position) {
      const t = this.open('SHORT', price);
      return t ? [t] : [];
    }
    if (this.position.side === 'LONG') {
      const close = this.close(price, 'opposite');
      const open  = this.open('SHORT', price);
      return open ? [close, open] : [close];
    }
    return []; // already short
  }

  // Enforce stop-loss / take-profit. Call on every price update (intra-candle).
  checkStops(price: number): Trade | null {
    const p = this.position;
    if (!p) return null;
    if (p.side === 'LONG') {
      if (price <= p.stopPrice)   return this.close(p.stopPrice, 'stop');
      if (price >= p.targetPrice) return this.close(p.targetPrice, 'target');
    } else {
      if (price >= p.stopPrice)   return this.close(p.stopPrice, 'stop');
      if (price <= p.targetPrice) return this.close(p.targetPrice, 'target');
    }
    return null;
  }

  private open(side: Side, price: number): Trade | null {
    const quantity = this.sizeQty(price);
    if (quantity <= 0) return null;
    const stopPrice   = side === 'LONG' ? price * (1 - this.stopPct) : price * (1 + this.stopPct);
    const targetPrice = side === 'LONG' ? price * (1 + this.stopPct * this.rr) : price * (1 - this.stopPct * this.rr);
    const entryFee = quantity * price * this.feeRate;
    this.usdtBalance -= entryFee;
    this.position = { side, entryPrice: price, quantity, entryTime: new Date(), stopPrice, targetPrice, entryFee };
    const trade: Trade = { type: side === 'LONG' ? 'BUY' : 'SELL', side, price, quantity, time: new Date(), reason: 'signal' };
    this.trades.push(trade);
    return trade;
  }

  private close(price: number, reason: Trade['reason']): Trade {
    const pos = this.position!;
    const gross = pos.side === 'LONG'
      ? (price - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - price) * pos.quantity;
    const exitFee = pos.quantity * price * this.feeRate;
    this.usdtBalance += gross - exitFee;
    const trade: Trade = {
      type: pos.side === 'LONG' ? 'SELL' : 'BUY',
      side: pos.side, price, quantity: pos.quantity, time: new Date(),
      pnl: gross - exitFee - pos.entryFee, reason,
    };
    this.trades.push(trade);
    this.position = null;
    return trade;
  }

  // Size so that a stop-out loses ~riskPerTrade of equity; cap to 1x notional (no leverage).
  private sizeQty(price: number): number {
    const equity = this.portfolioValue(price);
    const stopDistance = price * this.stopPct;
    if (stopDistance <= 0 || equity <= 0) return 0;
    const qty = (equity * this.riskPerTrade) / stopDistance;
    const maxQty = equity / price;
    return Math.max(0, Math.min(qty, maxQty));
  }

  private unrealized(price: number): number {
    const p = this.position;
    if (!p) return 0;
    return p.side === 'LONG' ? (price - p.entryPrice) * p.quantity : (p.entryPrice - price) * p.quantity;
  }

  portfolioValue(currentPrice: number): number {
    return this.usdtBalance + this.unrealized(currentPrice);
  }

  getState(currentPrice: number) {
    return {
      usdtBalance: this.usdtBalance,
      position: this.position,
      portfolioValue: this.portfolioValue(currentPrice),
      totalTrades: this.trades.length,
      trades: this.trades,
    };
  }
}
