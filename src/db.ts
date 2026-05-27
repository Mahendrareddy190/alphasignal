import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.DB_PATH || path.join(DATA_DIR, 'futures.db');
export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations for existing DBs
try { db.exec('ALTER TABLE positions ADD COLUMN tp_price REAL'); } catch {}
try { db.exec('ALTER TABLE positions ADD COLUMN sl_price REAL'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    demo_balance  REAL    NOT NULL DEFAULT 10000,
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS positions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    symbol           TEXT    NOT NULL,
    side             TEXT    NOT NULL,
    size             REAL    NOT NULL,
    entry_price      REAL    NOT NULL,
    leverage         INTEGER NOT NULL DEFAULT 20,
    margin_type      TEXT    NOT NULL DEFAULT 'cross',
    initial_margin   REAL    NOT NULL,
    mark_price       REAL,
    liquidation_price REAL,
    unrealized_pnl   REAL    NOT NULL DEFAULT 0,
    tp_price         REAL,
    sl_price         REAL,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    symbol       TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    side         TEXT    NOT NULL,
    price        REAL,
    stop_price   REAL,
    size         REAL    NOT NULL,
    leverage     INTEGER NOT NULL DEFAULT 20,
    margin_type  TEXT    NOT NULL DEFAULT 'cross',
    status       TEXT    NOT NULL DEFAULT 'OPEN',
    fill_price   REAL,
    created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    filled_at    TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    order_id   INTEGER,
    symbol     TEXT    NOT NULL,
    side       TEXT    NOT NULL,
    price      REAL    NOT NULL,
    size       REAL    NOT NULL,
    pnl        REAL    NOT NULL DEFAULT 0,
    fee        REAL    NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS pending_verifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    pass_hash  TEXT    NOT NULL,
    otp        TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    type          TEXT    NOT NULL,
    amount        REAL    NOT NULL,
    balance_after REAL    NOT NULL,
    note          TEXT,
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS closed_trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    symbol        TEXT    NOT NULL,
    direction     TEXT    NOT NULL,
    size          REAL    NOT NULL,
    leverage      INTEGER NOT NULL,
    margin_type   TEXT    NOT NULL,
    entry_price   REAL    NOT NULL,
    close_price   REAL    NOT NULL,
    pnl           REAL    NOT NULL,
    fee           REAL    NOT NULL,
    net_pnl       REAL    NOT NULL,
    roe           REAL    NOT NULL,
    entry_time    TEXT    NOT NULL,
    close_time    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    close_reason  TEXT    NOT NULL DEFAULT 'MANUAL',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

export interface User {
  id: number; username: string; email: string;
  password_hash: string; demo_balance: number; created_at: string;
}
export interface Position {
  id: number; user_id: number; symbol: string;
  side: 'LONG' | 'SHORT'; size: number; entry_price: number;
  leverage: number; margin_type: string; initial_margin: number;
  mark_price: number | null; liquidation_price: number | null;
  unrealized_pnl: number; tp_price: number | null; sl_price: number | null;
  created_at: string;
}
export interface Order {
  id: number; user_id: number; symbol: string;
  type: 'MARKET' | 'LIMIT' | 'STOP_LIMIT'; side: 'BUY' | 'SELL';
  price: number | null; stop_price: number | null; size: number;
  leverage: number; margin_type: string;
  status: 'OPEN' | 'FILLED' | 'CANCELLED'; fill_price: number | null;
  created_at: string; filled_at: string | null;
}
export interface ClosedTrade {
  id: number; user_id: number; symbol: string;
  direction: 'LONG' | 'SHORT'; size: number; leverage: number; margin_type: string;
  entry_price: number; close_price: number;
  pnl: number; fee: number; net_pnl: number; roe: number;
  entry_time: string; close_time: string; close_reason: string;
}
