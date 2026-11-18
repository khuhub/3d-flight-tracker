import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { SnapshotHub } from '../src/hub';

const T = 1_700_000_000;
const snapshot = {
  time: T,
  aircraft: [
    { icao24: 'abc123', callsign: 'X1', originCountry: 'Y', timePosition: T, lastContact: T, lat: 1, lon: 2, altitude: 9000, velocity: 200, heading: 90, verticalRate: 0 },
  ],
};

interface Event {
  event: string;
  data: string;
}

/** Minimal SSE reader over fetch so tests exercise the real HTTP stream. */
async function openStream(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const events: Event[] = [];
  const next = async (predicate: (e: Event) => boolean, timeoutMs = 2000): Promise<Event> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.findIndex(predicate);
      if (found >= 0) return events.splice(found, 1)[0]!;
      if (Date.now() > deadline) throw new Error('timed out waiting for event');
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data });
      }
    }
  };
  return { res, next, close: () => controller.abort() };
}

let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function start(hub: SnapshotHub): Promise<string> {
  server = createApp({ hub });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const waitFor = async (cond: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('SSE delivery', () => {
  it('sends the cached snapshot immediately, heartbeats, broadcasts and cleans up', async () => {
    const hub = new SnapshotHub({ mode: 'replay', pollIntervalS: 180, authenticated: false, heartbeatMs: 50 });
    hub.publishSnapshot(snapshot);
    const base = await start(hub);

    const a = await openStream(`${base}/api/stream`);
    expect(a.res.headers.get('content-type')).toContain('text/event-stream');
    expect(a.res.headers.get('cache-control')).toContain('no-cache');
    const initial = JSON.parse((await a.next((e) => e.event === 'snapshot')).data);
    expect(initial.sequence).toBe(1);
    expect(initial.aircraft[0][0]).toBe('abc123');

    // Heartbeats keep the connection alive and carry the server clock.
    await a.next((e) => e.event === 'status');
    const beat = JSON.parse((await a.next((e) => e.event === 'status', 1000)).data);
    expect(beat.mode).toBe('replay');
    expect(typeof beat.serverNow).toBe('number');

    const b = await openStream(`${base}/api/stream`);
    await b.next((e) => e.event === 'snapshot');
    expect(hub.clientCount).toBe(2);

    hub.publishSnapshot({ ...snapshot, time: T + 180 });
    expect(JSON.parse((await a.next((e) => e.event === 'snapshot')).data).time).toBe(T + 180);
    expect(JSON.parse((await b.next((e) => e.event === 'snapshot')).data).time).toBe(T + 180);

    a.close();
    await waitFor(() => hub.clientCount === 1);
    b.close();
    await waitFor(() => hub.clientCount === 0);
  });

  it('reports upstream problems while continuing to serve the last snapshot', async () => {
    const hub = new SnapshotHub({ mode: 'live', pollIntervalS: 180, authenticated: true, heartbeatMs: 10_000 });
    hub.publishSnapshot(snapshot);
    hub.updateStatus({ upstream: 'rate-limited', lastError: 'OpenSky rate limit reached (HTTP 429)' });
    const base = await start(hub);
    const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ mode: 'live', upstream: 'rate-limited', authenticated: true });
    expect(status.lastSuccessAt).toEqual(expect.any(Number));
    const s = await openStream(`${base}/api/stream`);
    expect(JSON.parse((await s.next((e) => e.event === 'snapshot')).data).time).toBe(T);
    s.close();
    await waitFor(() => hub.clientCount === 0);
  });

  it('starts without a snapshot and returns 404/405 for unknown routes', async () => {
    const hub = new SnapshotHub({ mode: 'live', pollIntervalS: 180, authenticated: false, heartbeatMs: 10_000 });
    const base = await start(hub);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/stream`, { method: 'POST' })).status).toBe(405);
    const s = await openStream(`${base}/api/stream`);
    expect(JSON.parse((await s.next((e) => e.event === 'status')).data).upstream).toBe('starting');
    s.close();
    await waitFor(() => hub.clientCount === 0);
  });
});
