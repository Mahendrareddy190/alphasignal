import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import * as futures from './futures';

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: any, res: any, next: any) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.userId = futures.verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function apiWrap(fn: (req: any, res: any) => any) {
  return async (req: any, res: any) => {
    try { res.json({ ok: true, data: await fn(req, res) }); }
    catch (e: any) { res.status(400).json({ ok: false, error: e.message }); }
  };
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/send-otp',   apiWrap(req => futures.sendRegistrationOtp(req.body.username, req.body.email, req.body.password)));
app.post('/api/auth/verify-otp', apiWrap(req => futures.verifyOtpAndRegister(req.body.email, req.body.otp)));
app.post('/api/auth/register',   apiWrap(req => futures.registerUser(req.body.username, req.body.email, req.body.password)));
app.post('/api/auth/login',      apiWrap(req => futures.loginUser(req.body.login, req.body.password)));

// ── Futures routes ────────────────────────────────────────────────────────────

app.get('/api/futures/balance',      requireAuth, apiWrap(req => futures.getBalance(req.userId)));
app.get('/api/futures/positions',    requireAuth, apiWrap(req => futures.getPositions(req.userId)));
app.get('/api/futures/orders',       requireAuth, apiWrap(req => futures.getOpenOrders(req.userId)));
app.get('/api/futures/history/orders', requireAuth, apiWrap(req => futures.getOrderHistory(req.userId)));
app.get('/api/futures/history/trades', requireAuth, apiWrap(req => futures.getTradeHistory(req.userId)));
app.get('/api/futures/history/closed', requireAuth, apiWrap(req => futures.getClosedTrades(req.userId)));
app.get('/api/futures/transactions', requireAuth, apiWrap(req => futures.getTransactions(req.userId)));
app.get('/api/futures/me',           requireAuth, apiWrap(req => futures.getUserInfo(req.userId)));

app.post('/api/futures/order', requireAuth, apiWrap(req => {
  const { symbol, type, side, size, leverage, marginType, price, stopPrice, currentPrice, tpPrice, slPrice } = req.body;
  return futures.placeOrder(req.userId, symbol, type, side, parseFloat(size), parseInt(leverage), marginType, price ? parseFloat(price) : undefined, stopPrice ? parseFloat(stopPrice) : undefined, currentPrice ? parseFloat(currentPrice) : undefined, tpPrice ? parseFloat(tpPrice) : undefined, slPrice ? parseFloat(slPrice) : undefined);
}));

app.delete('/api/futures/order/:id', requireAuth, apiWrap(req => futures.cancelOrder(req.userId, parseInt(req.params.id, 10))));
app.post('/api/futures/position/:id/close', requireAuth, apiWrap(req => futures.closePosition(req.userId, parseInt(req.params.id, 10), parseFloat(req.body.currentPrice))));
app.patch('/api/futures/position/:id/tpsl', requireAuth, apiWrap(req => {
  const { tpPrice, slPrice } = req.body;
  return futures.updatePositionTPSL(req.userId, parseInt(req.params.id), tpPrice ? parseFloat(tpPrice) : null, slPrice ? parseFloat(slPrice) : null);
}));

// ── WebSocket ─────────────────────────────────────────────────────────────────

interface ClientSub { symbol: string; interval: string; }
const clients = new Map<WebSocket, ClientSub>();

let stateGetter: ((symbol: string, interval: string) => object | null) | null = null;
export function setStateGetter(fn: typeof stateGetter) { stateGetter = fn; }

wss.on('connection', (ws) => {
  const sub: ClientSub = { symbol: 'BTCUSDT', interval: '1m' };
  clients.set(ws, sub);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && msg.symbol && msg.interval) {
        sub.symbol   = msg.symbol;
        sub.interval = msg.interval;
        if (stateGetter) {
          const state = stateGetter(msg.symbol, msg.interval);
          if (state && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'full', symbol: msg.symbol, interval: msg.interval, ...state }));
        }
      }
    } catch {}
  });
  ws.on('close', () => clients.delete(ws));
});

export function broadcastFull(symbol: string, interval: string, data: object) {
  const msg = JSON.stringify({ type: 'full', symbol, interval, ...data });
  for (const [ws, sub] of clients) {
    if (ws.readyState === WebSocket.OPEN && sub.symbol === symbol && sub.interval === interval)
      ws.send(msg);
  }
}

export function broadcastSummary(symbol: string, price: number, sig: object) {
  const msg = JSON.stringify({ type: 'summary', symbol, price, sig });
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function startServer(port = 3000) {
  httpServer.listen(port, () => console.log(`\n  Dashboard → http://localhost:${port}\n`));
}
