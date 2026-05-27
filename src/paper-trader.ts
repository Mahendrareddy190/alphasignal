export interface Position {
  entryPrice: number;
  quantity: number;
  entryTime: Date;
}

export interface Trade {
  type: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  time: Date;
  pnl?: number;
}

export class PaperTrader {
  private usdtBalance: number;
  private position: Position | null = null;
  private trades: Trade[] = [];
  private readonly tradeSize: number; // fraction of balance per trade

  constructor(initialBalance = 10_000, tradeSize = 0.95) {
    this.usdtBalance = initialBalance;
    this.tradeSize = tradeSize;
  }

  buy(price: number): Trade | null {
    if (this.position) return null;
    const quantity = (this.usdtBalance * this.tradeSize) / price;
    this.usdtBalance -= quantity * price;
    this.position = { entryPrice: price, quantity, entryTime: new Date() };
    const trade: Trade = { type: 'BUY', price, quantity, time: new Date() };
    this.trades.push(trade);
    return trade;
  }

  sell(price: number): Trade | null {
    if (!this.position) return null;
    const pnl = (price - this.position.entryPrice) * this.position.quantity;
    this.usdtBalance += this.position.quantity * price;
    const trade: Trade = {
      type: 'SELL',
      price,
      quantity: this.position.quantity,
      time: new Date(),
      pnl,
    };
    this.trades.push(trade);
    this.position = null;
    return trade;
  }

  portfolioValue(currentPrice: number): number {
    return this.usdtBalance + (this.position ? this.position.quantity * currentPrice : 0);
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
