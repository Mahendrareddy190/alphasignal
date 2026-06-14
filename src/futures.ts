import 'dotenv/config';
import { randomInt } from 'crypto';
import { db, tx, Q, User, Position, Order, ClosedTrade } from './db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendOtpEmail } from './mailer';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');

const TAKER_FEE  = 0.0004;
const MAKER_FEE  = 0.0002;
const MAINT_RATE = 0.005;

// ── Step 1: send OTP ─────────────────────────────────────────────────────────
export async function sendRegistrationOtp(username: string, email: string, password: string) {
  if (!username || !email || !password) throw new Error('Username, email and password are required');
  if (username.length < 3) throw new Error('Username must be at least 3 characters');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const emailLc = email.trim().toLowerCase();
  const userLc  = username.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) throw new Error('Invalid email address');

  const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', userLc, emailLc);
  if (existing) throw new Error('Username or email already taken');

  const hash    = bcrypt.hashSync(password, 10);
  const otp     = randomInt(100000, 1000000).toString();
  const expiry  = Math.max(1, parseInt(process.env.OTP_EXPIRY_MINUTES || '10') || 10);
  const expires = Date.now() + expiry * 60 * 1000;

  await db.run('DELETE FROM pending_verifications WHERE email = ?', emailLc);
  await db.run('INSERT INTO pending_verifications (email, username, pass_hash, otp, expires_at) VALUES (?, ?, ?, ?, ?)', emailLc, userLc, hash, otp, expires);

  try {
    await sendOtpEmail(emailLc, otp, userLc);
  } catch (err: any) {
    await db.run('DELETE FROM pending_verifications WHERE email = ?', emailLc);
    throw new Error('Failed to send verification email: ' + (err?.message || 'unknown error'));
  }
  return { message: 'Verification code sent to ' + emailLc };
}

// ── Step 2: verify OTP and create account ────────────────────────────────────
export async function verifyOtpAndRegister(email: string, otp: string) {
  if (!email || !otp) throw new Error('Email and OTP are required');
  const emailLc = email.trim().toLowerCase();
  const pending = await db.get('SELECT * FROM pending_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1', emailLc) as any;

  if (!pending) throw new Error('No pending verification for this email');
  if (Date.now() > Number(pending.expires_at)) {
    await db.run('DELETE FROM pending_verifications WHERE email = ?', emailLc);
    throw new Error('Code expired — please register again');
  }
  if (pending.otp !== otp.trim()) throw new Error('Invalid verification code');

  try {
    return await tx(async (q) => {
      const userId = await q.insert('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)', pending.username, emailLc, pending.pass_hash);
      await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', userId, 'DEPOSIT', 10000, 10000, 'Welcome — $10,000 demo balance');
      await q.run('DELETE FROM pending_verifications WHERE email = ?', emailLc);
      return { userId, username: pending.username, token: signToken(userId), message: 'Account created successfully' };
    });
  } catch (e: any) {
    if (e?.code === '23505' || e?.message?.includes('duplicate key')) throw new Error('Username or email already taken');
    throw e;
  }
}

export function registerUser(_username: string, _email: string, _password: string) {
  throw new Error('Please use the email verification flow');
}

export async function loginUser(login: string, password: string) {
  if (!login || !password) throw new Error('Login and password are required');
  const user = await db.get('SELECT * FROM users WHERE username = ? OR email = ?', login.trim().toLowerCase(), login.trim().toLowerCase()) as any | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    throw new Error('Invalid username or password');
  if (!user.email_verified)
    throw new Error('Email not verified — check your inbox for the verification code');
  const { password_hash, ...safe } = user;
  return { user: safe, token: signToken(user.id) };
}

export function verifyToken(token: string): number {
  const p = jwt.verify(token, JWT_SECRET!) as { userId: number };
  return p.userId;
}

function signToken(userId: number) {
  return jwt.sign({ userId }, JWT_SECRET!, { expiresIn: '7d' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function liqPrice(side: 'LONG' | 'SHORT', entry: number, leverage: number) {
  return side === 'LONG'
    ? entry * (1 - 1 / leverage + MAINT_RATE)
    : entry * (1 + 1 / leverage - MAINT_RATE);
}

function unrealizedPnl(side: 'LONG' | 'SHORT', entry: number, mark: number, size: number) {
  return side === 'LONG' ? (mark - entry) * size : (entry - mark) * size;
}

async function marginUsed(userId: number): Promise<number> {
  const rows = await db.all('SELECT initial_margin FROM positions WHERE user_id = ?', userId) as any[];
  return rows.reduce((s, r) => s + r.initial_margin, 0);
}

// ── Order placement ───────────────────────────────────────────────────────────

const VALID_SYMBOLS  = new Set(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','MATICUSDT','LINKUSDT','LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT']);
const VALID_TYPES    = new Set(['MARKET','LIMIT','STOP_LIMIT']);
const VALID_SIDES    = new Set(['BUY','SELL']);

export async function placeOrder(
  userId: number, symbol: string,
  type: 'MARKET' | 'LIMIT' | 'STOP_LIMIT', side: 'BUY' | 'SELL',
  size: number, leverage: number, marginType: string,
  price?: number, stopPrice?: number, currentPrice?: number,
  tpPrice?: number, slPrice?: number,
) {
  if (!VALID_SYMBOLS.has(symbol)) throw new Error('Invalid symbol');
  if (!VALID_TYPES.has(type))     throw new Error('Invalid order type');
  if (!VALID_SIDES.has(side))     throw new Error('Invalid side');
  if (!isFinite(size) || size <= 0) throw new Error('Size must be a positive number');
  if (!isFinite(leverage) || leverage < 1 || leverage > 125) throw new Error('Leverage must be 1–125x');

  const refPrice = type === 'MARKET' ? currentPrice : price;
  if (!refPrice || !isFinite(refPrice) || refPrice <= 0) throw new Error('A valid price is required');

  const notional      = refPrice * size;
  const initialMargin = notional / leverage;
  const fee           = notional * TAKER_FEE;
  const required      = initialMargin + fee;

  const user = await db.get('SELECT * FROM users WHERE id = ?', userId) as User;
  if (!user) throw new Error('User not found');
  const avbl = user.demo_balance - await marginUsed(userId);
  if (required > avbl)
    throw new Error(`Insufficient balance. Need $${required.toFixed(2)}, have $${avbl.toFixed(2)}`);

  if (type === 'MARKET') {
    const orderId = await db.insert(
      `INSERT INTO orders (user_id, symbol, type, side, price, stop_price, size, leverage, margin_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, symbol, 'MARKET', side, currentPrice!, null, size, leverage, marginType);
    return executeOpen(userId, symbol, side, size, currentPrice!, leverage, marginType, orderId, tpPrice, slPrice);
  }

  const orderId = await db.insert(
    `INSERT INTO orders (user_id, symbol, type, side, price, stop_price, size, leverage, margin_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, symbol, type, side, price ?? null, stopPrice ?? null, size, leverage, marginType);
  return { orderId, status: 'OPEN', message: `${type} order placed` };
}

async function executeOpen(
  userId: number, symbol: string, side: 'BUY' | 'SELL',
  size: number, fillPrice: number, leverage: number,
  marginType: string, orderId: number | null,
  tpPrice?: number, slPrice?: number,
) {
  const posSide: 'LONG' | 'SHORT' = side === 'BUY' ? 'LONG' : 'SHORT';
  const oppSide: 'LONG' | 'SHORT' = posSide === 'LONG' ? 'SHORT' : 'LONG';
  const fee = fillPrice * size * TAKER_FEE;

  return tx(async (q) => {
    const user   = await q.get('SELECT * FROM users WHERE id = ?', userId) as User;
    const oppPos = await q.get('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?', userId, symbol, oppSide) as Position | undefined;
    let pnl = 0;

    if (oppPos) {
      const closeSize    = Math.min(size, oppPos.size);
      pnl                = unrealizedPnl(oppPos.side, oppPos.entry_price, fillPrice, closeSize);
      const freedMargin  = oppPos.entry_price * closeSize / oppPos.leverage;
      const closeFee     = fillPrice * closeSize * TAKER_FEE;
      const netPnl       = pnl - closeFee;
      const roe          = freedMargin > 0 ? (netPnl / freedMargin) * 100 : 0;

      await q.run(`INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, symbol, oppPos.side, closeSize, oppPos.leverage, oppPos.margin_type, oppPos.entry_price, fillPrice, pnl, closeFee, netPnl, roe, oppPos.created_at);

      if (closeSize >= oppPos.size) {
        await q.run('DELETE FROM positions WHERE id = ?', oppPos.id);
      } else {
        await q.run('UPDATE positions SET size = size - ? WHERE id = ?', closeSize, oppPos.id);
      }

      const remaining = size - closeSize;
      if (remaining > 0) {
        await openNewPosition(q, userId, symbol, posSide, remaining, fillPrice, leverage, marginType, tpPrice, slPrice);
      }

      // Margin was reserved (never deducted from demo_balance), so it returns
      // automatically once the position row is gone — only realized PnL and fee move the wallet.
      const netChange = pnl - fee;
      const newBalance = user.demo_balance + netChange;
      await q.run('UPDATE users SET demo_balance = ? WHERE id = ?', newBalance, userId);
      await q.run('INSERT INTO trade_history (user_id, order_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, orderId, symbol, side, fillPrice, size, pnl, fee);
      await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', userId, 'FEE', -fee, newBalance, `${side} ${size} ${symbol} @ ${fillPrice}`);
      if (pnl !== 0) await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', userId, 'TRADE_PNL', pnl, newBalance, 'Realized PnL');
      if (orderId) await q.run("UPDATE orders SET status='FILLED', filled_at=now(), fill_price=? WHERE id=?", fillPrice, orderId);
      return { status: 'FILLED', fillPrice, pnl: pnl - fee };
    } else {
      const samePos = await q.get('SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?', userId, symbol, posSide) as Position | undefined;
      if (samePos) {
        const total    = samePos.size + size;
        const avgEntry = (samePos.entry_price * samePos.size + fillPrice * size) / total;
        await q.run('UPDATE positions SET size = ?, entry_price = ?, initial_margin = initial_margin + ?, liquidation_price = ?, mark_price = ? WHERE id = ?',
          total, avgEntry, fillPrice * size / leverage, liqPrice(posSide, avgEntry, leverage), fillPrice, samePos.id);
      } else {
        await openNewPosition(q, userId, symbol, posSide, size, fillPrice, leverage, marginType, tpPrice, slPrice);
      }

      const netChange  = -fee;
      const newBalance = user.demo_balance + netChange;
      await q.run('UPDATE users SET demo_balance = ? WHERE id = ?', newBalance, userId);
      await q.run('INSERT INTO trade_history (user_id, order_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, orderId, symbol, side, fillPrice, size, 0, fee);
      await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', userId, 'FEE', -fee, newBalance, `${side} ${size} ${symbol} @ ${fillPrice}`);
      if (orderId) await q.run("UPDATE orders SET status='FILLED', filled_at=now(), fill_price=? WHERE id=?", fillPrice, orderId);
      return { status: 'FILLED', fillPrice, pnl: -fee };
    }
  });
}

async function openNewPosition(q: Q, userId: number, symbol: string, side: 'LONG' | 'SHORT', size: number, entryPrice: number, leverage: number, marginType: string, tpPrice?: number, slPrice?: number) {
  await q.run(`INSERT INTO positions (user_id, symbol, side, size, entry_price, leverage, margin_type, initial_margin, mark_price, liquidation_price, tp_price, sl_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, symbol, side, size, entryPrice, leverage, marginType, entryPrice * size / leverage, entryPrice, liqPrice(side, entryPrice, leverage), tpPrice ?? null, slPrice ?? null);
}

export async function cancelOrder(userId: number, orderId: number) {
  if (!isFinite(orderId)) throw new Error('Invalid order ID');
  const o = await db.get("SELECT id FROM orders WHERE id = ? AND user_id = ? AND status = 'OPEN'", orderId, userId);
  if (!o) throw new Error('Order not found or already filled');
  await db.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", orderId);
}

export async function closePosition(userId: number, positionId: number, currentPrice: number) {
  if (!isFinite(positionId)) throw new Error('Invalid position ID');
  if (!isFinite(currentPrice) || currentPrice <= 0) throw new Error('currentPrice is required and must be positive');
  const pos = await db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', positionId, userId) as Position | undefined;
  if (!pos) throw new Error('Position not found');
  const side: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  return executeOpen(userId, pos.symbol, side, pos.size, currentPrice, pos.leverage, pos.margin_type, null);
}

// ── Price feed ────────────────────────────────────────────────────────────────

export async function onPriceUpdate(symbol: string, price: number) {
  const positions = await db.all('SELECT * FROM positions WHERE symbol = ?', symbol) as Position[];
  for (const pos of positions) {
    try {
      const upnl = unrealizedPnl(pos.side, pos.entry_price, price, pos.size);
      await db.run('UPDATE positions SET mark_price = ?, unrealized_pnl = ? WHERE id = ?', price, upnl, pos.id);

      const liq        = pos.liquidation_price ?? 0;
      const liquidated = pos.side === 'LONG' ? price <= liq : price >= liq;
      if (liquidated) { await liquidatePosition(pos, price); continue; }

      if (pos.tp_price) {
        const tpHit = pos.side === 'LONG' ? price >= pos.tp_price : price <= pos.tp_price;
        if (tpHit) { await executeTpSl(pos, price, 'TP'); continue; }
      }
      if (pos.sl_price) {
        const slHit = pos.side === 'LONG' ? price <= pos.sl_price : price >= pos.sl_price;
        if (slHit) { await executeTpSl(pos, price, 'SL'); continue; }
      }
    } catch (e) {
      console.error(`[onPriceUpdate] position ${pos.id}:`, e);
    }
  }

  // Fill limit orders at best available price
  const limitOrders = await db.all("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN' AND type = 'LIMIT'", symbol) as Order[];
  for (const o of limitOrders) {
    if (!o.price) continue;
    const hit = o.side === 'BUY' ? price <= o.price : price >= o.price;
    if (hit) {
      try {
        const fillPrice = o.side === 'BUY' ? Math.min(price, o.price) : Math.max(price, o.price);
        await executeOpen(o.user_id, symbol, o.side, o.size, fillPrice, o.leverage, o.margin_type, o.id);
      } catch (e) {
        console.error(`[onPriceUpdate] limit order ${o.id}:`, e);
      }
    }
  }

  const stopOrders = await db.all("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN' AND type = 'STOP_LIMIT'", symbol) as Order[];
  for (const o of stopOrders) {
    if (!o.stop_price) continue;
    const hit = o.side === 'BUY' ? price >= o.stop_price : price <= o.stop_price;
    if (hit) await db.run("UPDATE orders SET type = 'LIMIT' WHERE id = ?", o.id);
  }
}

async function liquidatePosition(pos: Position, markPrice: number) {
  return tx(async (q) => {
    const user       = await q.get('SELECT * FROM users WHERE id = ?', pos.user_id) as User;
    const loss       = -pos.initial_margin;
    const newBalance = Math.max(0, user.demo_balance + loss);
    await q.run('UPDATE users SET demo_balance = ? WHERE id = ?', newBalance, pos.user_id);
    await q.run('DELETE FROM positions WHERE id = ?', pos.id);
    await q.run('INSERT INTO trade_history (user_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?)', pos.user_id, pos.symbol, pos.side === 'LONG' ? 'SELL' : 'BUY', markPrice, pos.size, loss, 0);
    await q.run(`INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time, close_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pos.user_id, pos.symbol, pos.side, pos.size, pos.leverage, pos.margin_type, pos.entry_price, markPrice, loss, 0, loss, -100, pos.created_at, 'LIQUIDATION');
    await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', pos.user_id, 'LIQUIDATION', loss, newBalance, `LIQUIDATED ${pos.side} ${pos.symbol} @ ${markPrice}`);
  });
}

async function executeTpSl(pos: Position, markPrice: number, reason: 'TP' | 'SL') {
  return tx(async (q) => {
    const closeSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
    const pnl           = unrealizedPnl(pos.side, pos.entry_price, markPrice, pos.size);
    const fee           = markPrice * pos.size * TAKER_FEE;
    const freedMargin   = pos.entry_price * pos.size / pos.leverage;
    const netPnl        = pnl - fee;
    const roe           = freedMargin > 0 ? (netPnl / freedMargin) * 100 : 0;
    const user          = await q.get('SELECT * FROM users WHERE id = ?', pos.user_id) as User;
    // Margin was reserved, not deducted — only realized net PnL moves the wallet (see executeOpen).
    const newBalance    = user.demo_balance + netPnl;
    await q.run('UPDATE users SET demo_balance = ? WHERE id = ?', newBalance, pos.user_id);
    await q.run('DELETE FROM positions WHERE id = ?', pos.id);
    await q.run('INSERT INTO trade_history (user_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?)', pos.user_id, pos.symbol, closeSide, markPrice, pos.size, pnl, fee);
    await q.run(`INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time, close_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pos.user_id, pos.symbol, pos.side, pos.size, pos.leverage, pos.margin_type, pos.entry_price, markPrice, pnl, fee, netPnl, roe, pos.created_at, reason);
    await q.run('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)', pos.user_id, 'TRADE_PNL', netPnl, newBalance, `${reason} ${pos.side} ${pos.symbol} @ ${markPrice}`);
  });
}

export async function updatePositionTPSL(userId: number, positionId: number, tpPrice: number | null, slPrice: number | null) {
  if (!isFinite(positionId)) throw new Error('Invalid position ID');
  const pos = await db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', positionId, userId) as Position | undefined;
  if (!pos) throw new Error('Position not found');
  await db.run('UPDATE positions SET tp_price = ?, sl_price = ? WHERE id = ?', tpPrice, slPrice, positionId);
  return { ok: true };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getBalance(userId: number) {
  const user = await db.get('SELECT demo_balance FROM users WHERE id = ?', userId) as any;
  if (!user) throw new Error('User not found');
  const positions = await db.all('SELECT unrealized_pnl, initial_margin FROM positions WHERE user_id = ?', userId) as any[];
  const upnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  const used = positions.reduce((s, p) => s + p.initial_margin, 0);
  return {
    walletBalance:    user.demo_balance,
    unrealizedPnl:    upnl,
    marginBalance:    user.demo_balance + upnl,
    availableBalance: user.demo_balance - used,
    marginUsed:       used,
  };
}

export const getPositions    = (uid: number) => db.all('SELECT * FROM positions WHERE user_id = ? ORDER BY created_at DESC', uid);
export const getOpenOrders   = (uid: number) => db.all("SELECT * FROM orders WHERE user_id = ? AND status = 'OPEN' ORDER BY created_at DESC", uid);
export const getOrderHistory = (uid: number) => db.all("SELECT * FROM orders WHERE user_id = ? AND status != 'OPEN' ORDER BY created_at DESC LIMIT 100", uid);
export const getTradeHistory = (uid: number) => db.all('SELECT * FROM trade_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', uid);
export const getClosedTrades = (uid: number) => db.all('SELECT * FROM closed_trades WHERE user_id = ? ORDER BY close_time DESC LIMIT 200', uid);
export const getTransactions = (uid: number) => db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', uid);
export const getUserInfo     = (uid: number) => db.get('SELECT id, username, email, demo_balance, created_at FROM users WHERE id = ?', uid);
