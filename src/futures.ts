import 'dotenv/config';
import { db, User, Position, Order, ClosedTrade } from './db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendOtpEmail } from './mailer';

const JWT_SECRET = process.env.JWT_SECRET || 'alphasignal_demo_secret_2024';
const TAKER_FEE  = 0.0004;  // 0.04%
const MAKER_FEE  = 0.0002;  // 0.02%
const MAINT_RATE = 0.005;   // 0.5% maintenance margin

// ── Auth ──────────────────────────────────────────────────────────────────────

// ── Step 1: send OTP ─────────────────────────────────────────────────────────
export async function sendRegistrationOtp(username: string, email: string, password: string) {
  if (username.length < 3) throw new Error('Username must be at least 3 characters');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const emailLc = email.trim().toLowerCase();
  const userLc  = username.trim().toLowerCase();

  // Check if already registered
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(userLc, emailLc);
  if (existing) throw new Error('Username or email already taken');

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) throw new Error('Invalid email address');

  const hash    = bcrypt.hashSync(password, 10);
  const otp     = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry  = parseInt(process.env.OTP_EXPIRY_MINUTES || '10');
  const expires = Date.now() + expiry * 60 * 1000;

  // Remove any previous pending for this email
  db.prepare('DELETE FROM pending_verifications WHERE email = ?').run(emailLc);

  db.prepare(
    'INSERT INTO pending_verifications (email, username, pass_hash, otp, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(emailLc, userLc, hash, otp, expires);

  try {
    await sendOtpEmail(emailLc, otp, userLc);
  } catch (err: any) {
    // Clean up pending record if email fails
    db.prepare('DELETE FROM pending_verifications WHERE email = ?').run(emailLc);
    const msg = err?.code === 'ECONNECTION' || err?.code === 'ETIMEDOUT'
      ? 'Email service unavailable. Check EMAIL_USER and EMAIL_PASS environment variables.'
      : 'Failed to send verification email: ' + (err?.message || 'unknown error');
    throw new Error(msg);
  }
  return { message: 'Verification code sent to ' + emailLc };
}

// ── Step 2: verify OTP and create account ────────────────────────────────────
export function verifyOtpAndRegister(email: string, otp: string) {
  const emailLc = email.trim().toLowerCase();
  const pending = db.prepare(
    'SELECT * FROM pending_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1'
  ).get(emailLc) as any;

  if (!pending) throw new Error('No pending verification for this email');
  if (Date.now() > pending.expires_at) {
    db.prepare('DELETE FROM pending_verifications WHERE email = ?').run(emailLc);
    throw new Error('Code expired — please register again');
  }
  if (pending.otp !== otp.trim()) throw new Error('Invalid verification code');

  // Create the user
  try {
    const r = db.prepare(
      'INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)'
    ).run(pending.username, emailLc, pending.pass_hash);
    const userId = r.lastInsertRowid as number;
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, 'DEPOSIT', 10000, 10000, 'Welcome — $10,000 demo balance');
    db.prepare('DELETE FROM pending_verifications WHERE email = ?').run(emailLc);
    return { userId, username: pending.username, token: signToken(userId), message: 'Account created successfully' };
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) throw new Error('Username or email already taken');
    throw e;
  }
}

// ── Legacy registerUser (kept for compatibility) ─────────────────────────────
export function registerUser(username: string, email: string, password: string) {
  throw new Error('Please use the email verification flow');
}

export function loginUser(login: string, password: string) {
  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ?'
  ).get(login.trim().toLowerCase(), login.trim().toLowerCase()) as User | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    throw new Error('Invalid username or password');
  const { password_hash, ...safe } = user;
  return { user: safe, token: signToken(user.id) };
}

export function verifyToken(token: string): number {
  const p = jwt.verify(token, JWT_SECRET) as { userId: number };
  return p.userId;
}

function signToken(userId: number) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
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

function marginUsed(userId: number): number {
  const rows = db.prepare('SELECT initial_margin FROM positions WHERE user_id = ?').all(userId) as any[];
  return rows.reduce((s, r) => s + r.initial_margin, 0);
}

// ── Order placement ───────────────────────────────────────────────────────────

export function placeOrder(
  userId: number,
  symbol: string,
  type: 'MARKET' | 'LIMIT' | 'STOP_LIMIT',
  side: 'BUY' | 'SELL',
  size: number,
  leverage: number,
  marginType: string,
  price?: number,
  stopPrice?: number,
  currentPrice?: number,
  tpPrice?: number,
  slPrice?: number,
) {
  if (size <= 0) throw new Error('Size must be positive');
  if (leverage < 1 || leverage > 125) throw new Error('Leverage must be 1–125x');

  const refPrice = type === 'MARKET' ? currentPrice! : price!;
  if (!refPrice) throw new Error('Price is required');

  const notional      = refPrice * size;
  const initialMargin = notional / leverage;
  const fee           = notional * TAKER_FEE;
  const required      = initialMargin + fee;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
  if (!user) throw new Error('User not found');
  const avbl = user.demo_balance - marginUsed(userId);
  if (required > avbl)
    throw new Error(`Insufficient balance. Need $${required.toFixed(2)}, have $${avbl.toFixed(2)}`);

  if (type === 'MARKET') {
    const mktRow = db.prepare(
      `INSERT INTO orders (user_id, symbol, type, side, price, stop_price, size, leverage, margin_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, symbol, 'MARKET', side, currentPrice!, null, size, leverage, marginType);
    return executeOpen(userId, symbol, side, size, currentPrice!, leverage, marginType, mktRow.lastInsertRowid as number, tpPrice, slPrice);
  }

  const r = db.prepare(
    `INSERT INTO orders (user_id, symbol, type, side, price, stop_price, size, leverage, margin_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, symbol, type, side, price ?? null, stopPrice ?? null, size, leverage, marginType);
  return { orderId: r.lastInsertRowid, status: 'OPEN', message: `${type} order placed` };
}

function executeOpen(
  userId: number, symbol: string, side: 'BUY' | 'SELL',
  size: number, fillPrice: number, leverage: number,
  marginType: string, orderId: number | null,
  tpPrice?: number, slPrice?: number,
) {
  const posSide: 'LONG' | 'SHORT' = side === 'BUY' ? 'LONG' : 'SHORT';
  const oppSide: 'LONG' | 'SHORT' = posSide === 'LONG' ? 'SHORT' : 'LONG';
  const fee = fillPrice * size * TAKER_FEE;

  const user  = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
  const oppPos = db.prepare(
    'SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?'
  ).get(userId, symbol, oppSide) as Position | undefined;

  let pnl = 0;

  if (oppPos) {
    // Closing / reducing opposite position
    const closeSize = Math.min(size, oppPos.size);
    pnl = unrealizedPnl(oppPos.side, oppPos.entry_price, fillPrice, closeSize);
    const initialMargin = oppPos.entry_price * closeSize / oppPos.leverage;
    const closeFee = fillPrice * closeSize * TAKER_FEE;
    const netPnl = pnl - closeFee;
    const roe = initialMargin > 0 ? (netPnl / initialMargin) * 100 : 0;
    db.prepare(
      `INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, symbol, oppPos.side, closeSize, oppPos.leverage, oppPos.margin_type,
          oppPos.entry_price, fillPrice, pnl, closeFee, netPnl, roe, oppPos.created_at);
    if (closeSize >= oppPos.size) {
      db.prepare('DELETE FROM positions WHERE id = ?').run(oppPos.id);
    } else {
      db.prepare('UPDATE positions SET size = size - ? WHERE id = ?').run(closeSize, oppPos.id);
    }
    const remaining = size - closeSize;
    if (remaining > 0) {
      openNewPosition(userId, symbol, posSide, remaining, fillPrice, leverage, marginType, tpPrice, slPrice);
    }
  } else {
    // Opening or adding to same-side position
    const samePos = db.prepare(
      'SELECT * FROM positions WHERE user_id = ? AND symbol = ? AND side = ?'
    ).get(userId, symbol, posSide) as Position | undefined;
    if (samePos) {
      const total = samePos.size + size;
      const avgEntry = (samePos.entry_price * samePos.size + fillPrice * size) / total;
      db.prepare(
        'UPDATE positions SET size = ?, entry_price = ?, initial_margin = initial_margin + ?, liquidation_price = ?, mark_price = ? WHERE id = ?'
      ).run(total, avgEntry, fillPrice * size / leverage, liqPrice(posSide, avgEntry, leverage), fillPrice, samePos.id);
    } else {
      openNewPosition(userId, symbol, posSide, size, fillPrice, leverage, marginType, tpPrice, slPrice);
    }
  }

  const netChange = pnl - fee;
  const newBalance = user.demo_balance + netChange;
  db.prepare('UPDATE users SET demo_balance = ? WHERE id = ?').run(newBalance, userId);
  db.prepare('INSERT INTO trade_history (user_id, order_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(userId, orderId, symbol, side, fillPrice, size, pnl, fee);
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)').run(userId, 'FEE', -fee, newBalance, `${side} ${size} ${symbol} @ ${fillPrice}`);
  if (pnl !== 0) db.prepare('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)').run(userId, 'TRADE_PNL', pnl, newBalance, `Realized PnL`);
  if (orderId) db.prepare("UPDATE orders SET status='FILLED', filled_at=CURRENT_TIMESTAMP, fill_price=? WHERE id=?").run(fillPrice, orderId);

  return { status: 'FILLED', fillPrice, pnl: pnl - fee };
}

function openNewPosition(userId: number, symbol: string, side: 'LONG' | 'SHORT', size: number, entryPrice: number, leverage: number, marginType: string, tpPrice?: number, slPrice?: number) {
  db.prepare(
    `INSERT INTO positions (user_id, symbol, side, size, entry_price, leverage, margin_type, initial_margin, mark_price, liquidation_price, tp_price, sl_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, symbol, side, size, entryPrice, leverage, marginType, entryPrice * size / leverage, entryPrice, liqPrice(side, entryPrice, leverage), tpPrice ?? null, slPrice ?? null);
}

export function cancelOrder(userId: number, orderId: number) {
  const o = db.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ? AND status = 'OPEN'").get(orderId, userId);
  if (!o) throw new Error('Order not found or already filled');
  db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);
}

export function closePosition(userId: number, positionId: number, currentPrice: number) {
  const pos = db.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?').get(positionId, userId) as Position | undefined;
  if (!pos) throw new Error('Position not found');
  const side: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  return executeOpen(userId, pos.symbol, side, pos.size, currentPrice, pos.leverage, pos.margin_type, null);
}

// ── Price feed — called from index.ts on every summary broadcast ──────────────

export function onPriceUpdate(symbol: string, price: number) {
  // Mark positions to market
  const positions = db.prepare('SELECT * FROM positions WHERE symbol = ?').all(symbol) as Position[];
  for (const pos of positions) {
    const upnl = unrealizedPnl(pos.side, pos.entry_price, price, pos.size);
    db.prepare('UPDATE positions SET mark_price = ?, unrealized_pnl = ? WHERE id = ?').run(price, upnl, pos.id);

    // Liquidation check
    const liq = pos.liquidation_price ?? 0;
    const liquidated = pos.side === 'LONG' ? price <= liq : price >= liq;
    if (liquidated) { liquidatePosition(pos, price); continue; }

    // TP/SL check
    if (pos.tp_price) {
      const tpHit = pos.side === 'LONG' ? price >= pos.tp_price : price <= pos.tp_price;
      if (tpHit) { executeTpSl(pos, price, 'TP'); continue; }
    }
    if (pos.sl_price) {
      const slHit = pos.side === 'LONG' ? price <= pos.sl_price : price >= pos.sl_price;
      if (slHit) { executeTpSl(pos, price, 'SL'); continue; }
    }
  }

  // Fill limit orders
  const limitOrders = db.prepare("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN' AND type = 'LIMIT'").all(symbol) as Order[];
  for (const o of limitOrders) {
    if (!o.price) continue;
    const hit = o.side === 'BUY' ? price <= o.price : price >= o.price;
    if (hit) executeOpen(o.user_id, symbol, o.side, o.size, o.price, o.leverage, o.margin_type, o.id);
  }

  // Activate stop-limit orders
  const stopOrders = db.prepare("SELECT * FROM orders WHERE symbol = ? AND status = 'OPEN' AND type = 'STOP_LIMIT'").all(symbol) as Order[];
  for (const o of stopOrders) {
    if (!o.stop_price) continue;
    const hit = o.side === 'BUY' ? price >= o.stop_price : price <= o.stop_price;
    if (hit) db.prepare("UPDATE orders SET type = 'LIMIT' WHERE id = ?").run(o.id);
  }
}

function liquidatePosition(pos: Position, markPrice: number) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pos.user_id) as User;
  const loss = -pos.initial_margin;
  const roe = -100;
  const newBalance = Math.max(0, user.demo_balance + loss);
  db.prepare('UPDATE users SET demo_balance = ? WHERE id = ?').run(newBalance, pos.user_id);
  db.prepare('DELETE FROM positions WHERE id = ?').run(pos.id);
  db.prepare('INSERT INTO trade_history (user_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?)').run(pos.user_id, pos.symbol, pos.side === 'LONG' ? 'SELL' : 'BUY', markPrice, pos.size, loss, 0);
  db.prepare(`INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time, close_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pos.user_id, pos.symbol, pos.side, pos.size, pos.leverage, pos.margin_type, pos.entry_price, markPrice, loss, 0, loss, roe, pos.created_at, 'LIQUIDATION');
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)').run(pos.user_id, 'LIQUIDATION', loss, newBalance, `LIQUIDATED ${pos.side} ${pos.symbol} @ ${markPrice}`);
}

function executeTpSl(pos: Position, markPrice: number, reason: 'TP' | 'SL') {
  const closeSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  const pnl = unrealizedPnl(pos.side, pos.entry_price, markPrice, pos.size);
  const fee = markPrice * pos.size * TAKER_FEE;
  const netPnl = pnl - fee;
  const initialMargin = pos.entry_price * pos.size / pos.leverage;
  const roe = initialMargin > 0 ? (netPnl / initialMargin) * 100 : 0;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pos.user_id) as User;
  const newBalance = user.demo_balance + netPnl;
  db.prepare('UPDATE users SET demo_balance = ? WHERE id = ?').run(newBalance, pos.user_id);
  db.prepare('DELETE FROM positions WHERE id = ?').run(pos.id);
  db.prepare('INSERT INTO trade_history (user_id, symbol, side, price, size, pnl, fee) VALUES (?, ?, ?, ?, ?, ?, ?)').run(pos.user_id, pos.symbol, closeSide, markPrice, pos.size, pnl, fee);
  db.prepare(`INSERT INTO closed_trades (user_id, symbol, direction, size, leverage, margin_type, entry_price, close_price, pnl, fee, net_pnl, roe, entry_time, close_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(pos.user_id, pos.symbol, pos.side, pos.size, pos.leverage, pos.margin_type, pos.entry_price, markPrice, pnl, fee, netPnl, roe, pos.created_at, reason);
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?)').run(pos.user_id, 'TRADE_PNL', netPnl, newBalance, `${reason} ${pos.side} ${pos.symbol} @ ${markPrice}`);
}

export function updatePositionTPSL(userId: number, positionId: number, tpPrice: number | null, slPrice: number | null) {
  const pos = db.prepare('SELECT * FROM positions WHERE id = ? AND user_id = ?').get(positionId, userId) as Position | undefined;
  if (!pos) throw new Error('Position not found');
  db.prepare('UPDATE positions SET tp_price = ?, sl_price = ? WHERE id = ?').run(tpPrice, slPrice, positionId);
  return { ok: true };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getBalance(userId: number) {
  const user = db.prepare('SELECT demo_balance FROM users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('User not found');
  const positions = db.prepare('SELECT unrealized_pnl, initial_margin FROM positions WHERE user_id = ?').all(userId) as any[];
  const upnl    = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  const used    = positions.reduce((s, p) => s + p.initial_margin, 0);
  return {
    walletBalance:    user.demo_balance,
    unrealizedPnl:    upnl,
    marginBalance:    user.demo_balance + upnl,
    availableBalance: user.demo_balance - used,
    marginUsed:       used,
  };
}

export const getPositions     = (uid: number) => db.prepare('SELECT * FROM positions WHERE user_id = ? ORDER BY created_at DESC').all(uid);
export const getOpenOrders    = (uid: number) => db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'OPEN' ORDER BY created_at DESC").all(uid);
export const getOrderHistory  = (uid: number) => db.prepare("SELECT * FROM orders WHERE user_id = ? AND status != 'OPEN' ORDER BY created_at DESC LIMIT 100").all(uid);
export const getTradeHistory  = (uid: number) => db.prepare('SELECT * FROM trade_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(uid);
export const getClosedTrades  = (uid: number) => db.prepare('SELECT * FROM closed_trades WHERE user_id = ? ORDER BY close_time DESC LIMIT 200').all(uid);
export const getTransactions  = (uid: number) => db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(uid);
export const getUserInfo      = (uid: number) => db.prepare('SELECT id, username, email, demo_balance, created_at FROM users WHERE id = ?').get(uid);
