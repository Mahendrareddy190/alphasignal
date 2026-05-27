import WebSocket from 'ws';
import { Candle, fetchCandles } from './fetcher';

const COMBINED_WS = 'wss://stream.binance.com:9443/stream';

export interface StreamUpdate {
  symbol:   string;
  interval: string;
  candles:  Candle[];
  isClosed: boolean;
  isLive:   boolean;  // false during bootstrap, true for real-time WebSocket ticks
}

export type StreamCallback = (update: StreamUpdate) => void;

export async function startCombinedStream(
  pairs:    { symbol: string; interval: string }[],
  onUpdate: StreamCallback
): Promise<void> {

  // Lookup: "btcusdt@kline_1m" → { symbol, interval }
  const pairMap = new Map(
    pairs.map(p => [`${p.symbol.toLowerCase()}@kline_${p.interval}`, p])
  );

  // Per-pair rolling candle arrays
  const store = new Map<string, Candle[]>();

  // Bootstrap historical data — batches of 10 to stay well under Binance rate limits
  const BATCH = 10;
  for (let i = 0; i < pairs.length; i += BATCH) {
    await Promise.allSettled(
      pairs.slice(i, i + BATCH).map(async ({ symbol, interval }) => {
        const k       = `${symbol}:${interval}`;
        const candles = await fetchCandles(symbol, interval, 500);
        store.set(k, candles);
        onUpdate({ symbol, interval, candles: [...candles], isClosed: false, isLive: false });
      })
    );
  }
  console.log(`  [stream] ${pairs.length} pairs bootstrapped`);

  // Single combined WebSocket connection
  const streams = [...pairMap.keys()].join('/');

  function connect() {
    const ws = new WebSocket(`${COMBINED_WS}?streams=${streams}`);

    ws.on('open', () => console.log('  [stream] Combined WebSocket connected\n'));

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const pair = pairMap.get(msg.stream);
      if (!pair) return;

      const { k }  = msg.data;
      const storeKey = `${pair.symbol}:${pair.interval}`;
      const live: Candle = {
        openTime: k.t,
        open:  parseFloat(k.o), high:  parseFloat(k.h),
        low:   parseFloat(k.l), close: parseFloat(k.c),
        volume: parseFloat(k.v),
      };

      const arr  = store.get(storeKey)!;
      const last = arr[arr.length - 1];
      if (last && last.openTime === live.openTime) {
        arr[arr.length - 1] = live;
      } else {
        arr.push(live);
        if (arr.length > 600) arr.splice(0, arr.length - 500);
      }

      onUpdate({ symbol: pair.symbol, interval: pair.interval, candles: [...arr], isClosed: k.x === true, isLive: true });
    });

    ws.on('error', err  => console.error('[stream]', err.message));
    ws.on('close', ()   => { console.warn('[stream] closed — reconnecting in 3 s'); setTimeout(connect, 3000); });
  }

  connect();
}
