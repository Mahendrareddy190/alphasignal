import { Pool, PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL env var is required (Neon Postgres connection string)');

// Neon requires SSL. rejectUnauthorized:false is fine for the pooled endpoint.
export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// better-sqlite3 used `?` placeholders; Postgres uses $1..$n. Convert on the fly
// so the SQL strings in futures.ts stay unchanged.
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Exec = (sql: string, params: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export interface Q {
  get<T = any>(sql: string, ...params: any[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<{ rowCount: number }>;
  // INSERT helper — appends RETURNING id and returns the new row id.
  insert(sql: string, ...params: any[]): Promise<number>;
}

function makeQ(exec: Exec): Q {
  return {
    async get(sql, ...params) { return (await exec(toPg(sql), params)).rows[0]; },
    async all(sql, ...params) { return (await exec(toPg(sql), params)).rows; },
    async run(sql, ...params) { return { rowCount: (await exec(toPg(sql), params)).rowCount ?? 0 }; },
    async insert(sql, ...params) { return (await exec(toPg(sql) + ' RETURNING id', params)).rows[0].id; },
  };
}

// Pool-level query helper (auto-commit per statement).
export const db: Q = makeQ((sql, params) => pool.query(sql, params));

// Transaction helper — all statements inside run on one client with BEGIN/COMMIT.
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = makeQ((sql, params) => client.query(sql, params));
    const result = await fn(q);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Create the schema if it doesn't exist. Call once at startup before serving.
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      username       TEXT             UNIQUE NOT NULL,
      email          TEXT             UNIQUE NOT NULL,
      password_hash  TEXT             NOT NULL,
      demo_balance   DOUBLE PRECISION NOT NULL DEFAULT 10000,
      email_verified INTEGER          NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS positions (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER          NOT NULL REFERENCES users(id),
      symbol            TEXT             NOT NULL,
      side              TEXT             NOT NULL,
      size              DOUBLE PRECISION NOT NULL,
      entry_price       DOUBLE PRECISION NOT NULL,
      leverage          INTEGER          NOT NULL DEFAULT 20,
      margin_type       TEXT             NOT NULL DEFAULT 'cross',
      initial_margin    DOUBLE PRECISION NOT NULL,
      mark_price        DOUBLE PRECISION,
      liquidation_price DOUBLE PRECISION,
      unrealized_pnl    DOUBLE PRECISION NOT NULL DEFAULT 0,
      tp_price          DOUBLE PRECISION,
      sl_price          DOUBLE PRECISION,
      created_at        TIMESTAMPTZ      NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER          NOT NULL REFERENCES users(id),
      symbol       TEXT             NOT NULL,
      type         TEXT             NOT NULL,
      side         TEXT             NOT NULL,
      price        DOUBLE PRECISION,
      stop_price   DOUBLE PRECISION,
      size         DOUBLE PRECISION NOT NULL,
      leverage     INTEGER          NOT NULL DEFAULT 20,
      margin_type  TEXT             NOT NULL DEFAULT 'cross',
      status       TEXT             NOT NULL DEFAULT 'OPEN',
      fill_price   DOUBLE PRECISION,
      created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
      filled_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS trade_history (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER          NOT NULL REFERENCES users(id),
      order_id   INTEGER,
      symbol     TEXT             NOT NULL,
      side       TEXT             NOT NULL,
      price      DOUBLE PRECISION NOT NULL,
      size       DOUBLE PRECISION NOT NULL,
      pnl        DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee        DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pending_verifications (
      id         SERIAL PRIMARY KEY,
      email      TEXT    NOT NULL,
      username   TEXT    NOT NULL,
      pass_hash  TEXT    NOT NULL,
      otp        TEXT    NOT NULL,
      expires_at BIGINT  NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER          NOT NULL REFERENCES users(id),
      type          TEXT             NOT NULL,
      amount        DOUBLE PRECISION NOT NULL,
      balance_after DOUBLE PRECISION NOT NULL,
      note          TEXT,
      created_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS closed_trades (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER          NOT NULL REFERENCES users(id),
      symbol        TEXT             NOT NULL,
      direction     TEXT             NOT NULL,
      size          DOUBLE PRECISION NOT NULL,
      leverage      INTEGER          NOT NULL,
      margin_type   TEXT             NOT NULL,
      entry_price   DOUBLE PRECISION NOT NULL,
      close_price   DOUBLE PRECISION NOT NULL,
      pnl           DOUBLE PRECISION NOT NULL,
      fee           DOUBLE PRECISION NOT NULL,
      net_pnl       DOUBLE PRECISION NOT NULL,
      roe           DOUBLE PRECISION NOT NULL,
      entry_time    TIMESTAMPTZ      NOT NULL,
      close_time    TIMESTAMPTZ      NOT NULL DEFAULT now(),
      close_reason  TEXT             NOT NULL DEFAULT 'MANUAL'
    );
  `);
}

export interface User {
  id: number; username: string; email: string;
  password_hash: string; demo_balance: number; email_verified: number; created_at: string;
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
