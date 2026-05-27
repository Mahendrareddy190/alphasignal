import { IndicatorResult } from './indicators';
import { SignalResult } from './signals';
import { Position, Trade } from './paper-trader';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const LINE   = '─'.repeat(58);
const DLINE  = '═'.repeat(58);

function signalColor(s: string) {
  if (s === 'BUY')  return `${GREEN}${BOLD}${s}${RESET}`;
  if (s === 'SELL') return `${RED}${BOLD}${s}${RESET}`;
  return `${YELLOW}${s}${RESET}`;
}

export function logTick(opts: {
  symbol: string;
  price: number;
  ind: IndicatorResult;
  sig: SignalResult;
  portfolioValue: number;
  usdtBalance: number;
  position: Position | null;
  lastTrade: Trade | null;
  tickCount: number;
}) {
  const { symbol, price, ind, sig, portfolioValue, usdtBalance, position, lastTrade, tickCount } = opts;

  console.clear();
  const ts = new Date().toLocaleTimeString();

  console.log(DLINE);
  console.log(`  ${CYAN}${BOLD}TRADE BOT${RESET}  ${symbol}   ${ts}   tick #${tickCount}`);
  console.log(DLINE);

  console.log(`  Price         $${price.toFixed(2)}`);
  console.log(`  Portfolio     $${portfolioValue.toFixed(2)} USDT`);
  console.log(`  Free USDT     $${usdtBalance.toFixed(2)}`);

  if (position) {
    const pnl = (price - position.entryPrice) * position.quantity;
    const pnlStr = pnl >= 0 ? `${GREEN}+$${pnl.toFixed(2)}${RESET}` : `${RED}-$${Math.abs(pnl).toFixed(2)}${RESET}`;
    console.log(`  Position      ${position.quantity.toFixed(6)} BTC @ $${position.entryPrice.toFixed(2)}  unrealised PnL: ${pnlStr}`);
  } else {
    console.log(`  Position      ${YELLOW}None${RESET}`);
  }

  console.log(LINE);
  console.log('  INDICATORS');
  console.log(`  RSI (14)      ${ind.rsi?.toFixed(2) ?? 'N/A'}`);
  console.log(`  MACD          ${ind.macdValue?.toFixed(4) ?? 'N/A'}   histogram: ${ind.macdHistogram?.toFixed(4) ?? 'N/A'}`);
  console.log(`  EMA 9 / 21    ${ind.ema9?.toFixed(2) ?? 'N/A'}  /  ${ind.ema21?.toFixed(2) ?? 'N/A'}`);

  console.log(LINE);
  console.log(`  SIGNAL        ${signalColor(sig.signal)}   confidence: ${sig.confidence}%`);
  for (const r of sig.reasons) console.log(`    • ${r}`);

  if (lastTrade) {
    console.log(LINE);
    const pnlPart =
      lastTrade.pnl !== undefined
        ? `  PnL: ${lastTrade.pnl >= 0 ? GREEN + '+' : RED}$${Math.abs(lastTrade.pnl).toFixed(2)}${RESET}`
        : '';
    console.log(`  LAST TRADE    ${signalColor(lastTrade.type)} @ $${lastTrade.price.toFixed(2)}  qty: ${lastTrade.quantity.toFixed(6)}${pnlPart}`);
  }

  console.log(DLINE);
}
