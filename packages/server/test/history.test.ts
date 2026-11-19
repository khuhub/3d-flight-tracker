import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { HistoryIndex, SnapshotMessage } from '@flight/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { HISTORY_WINDOW_MS, SnapshotHistory } from '../src/history';
import { SnapshotHub } from '../src/hub';
import { loadRecordings, shiftSnapshot } from '../src/replay';
import { loadRouteDatabase } from '../src/routes';

const [first, second] = loadRecordings(join(import.meta.dirname, 'fixtures/replay'));
const T = 1_800_000_000_000;

function makeHub(now: () => number) {
  return new SnapshotHub({ mode: 'replay', pollIntervalS: 180, authenticated: false, heartbeatMs: 15_000, now });
}

afterEach(() => vi.useRealTimers());

describe('snapshot history', () => {
  it('expires a frame at the actual last-hour cutoff, even if ingestion stops', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const hub = makeHub(Date.now);
    hub.publishSnapshot(first!.snapshot);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(HISTORY_WINDOW_MS);
    const index = hub.history.index();
    expect(index.frames).toEqual([{ sequence: 1, capturedAt: T, replayEpoch: 0 }]);
    expect(hub.history.frame(index.generation, 1)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.history.index().frames).toEqual([]);
    expect(hub.history.frame(index.generation, 1)).toBeUndefined();
    expect(hub.latestSnapshot?.sequence).toBe(1); // Still cached for live/SSE clients.
    hub.close();
  });

  it('seeds the preceding ten minutes plus an anchor and stops at an epoch or reversed observation time', () => {
    let now = T;
    const hub = makeHub(() => now);
    const take = (at: number, observationTime: number, epoch: number) => {
      now = T + at;
      hub.publishSnapshot({ ...first!.snapshot, time: observationTime }, epoch);
    };
    const minute = 60_000;
    take(0, 1000, 0);
    take(minute, 1001, 0);
    take(2 * minute, 1002, 0);
    take(3 * minute, 1003, 0);
    take(12 * minute, 1004, 0);
    take(12 * minute + 10, 1005, 1);
    take(12 * minute + 20, 1006, 1);
    take(12 * minute + 30, 1004, 1);
    const { generation, frames } = hub.history.index();
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const sequences = (at: number) => hub.history.seed(generation, T + at)
      ?.map(({ gzip }) => (JSON.parse(gunzipSync(gzip).toString()) as SnapshotMessage).sequence);
    expect(sequences(-1)).toBeUndefined();
    expect(sequences(12 * minute)).toEqual([3, 4, 5]);
    expect(sequences(12 * minute + 9)).toEqual([3, 4, 5]);
    expect(sequences(12 * minute + 29)).toEqual([6, 7]);
    expect(sequences(12 * minute + 30)).toEqual([8]);
    now -= 1;
    expect(hub.history.index()).toMatchObject({ generation: expect.not.stringMatching(generation), frames: [] });
    expect(hub.history.frame(generation, 8)).toBeUndefined();
    hub.close();
  });

  it('enforces count, total bytes, oversized frames, and maximum seed response under rapid ingestion', () => {
    let now = T;
    const hub = makeHub(() => now);
    const sample = hub.publishSnapshot(first!.snapshot);
    const json = (m: SnapshotMessage) => JSON.stringify(m);
    const frameBytes = Buffer.byteLength(json(sample)) + 32;
    const compressedBytes = gzipSync(json(sample), { level: 1 }).length + 32;
    const archive = new SnapshotHistory(() => now, { bytes: 5 * compressedBytes, frames: 4, seedFrames: 2 });
    for (let sequence = 1; sequence <= 1000; sequence++) {
      const message = { ...sample, sequence, serverNow: ++now };
      archive.append(message, json(message));
    }
    const index = archive.index();
    expect(index.frames.map(({ sequence }) => sequence)).toEqual([997, 998, 999, 1000]);
    expect(archive.seed(index.generation, now)).toHaveLength(2);

    const oneFrame = new SnapshotHistory(() => now, { bytes: compressedBytes, frameBytes, seedBytes: frameBytes + 2 });
    for (let sequence = 1; sequence <= 3; sequence++) {
      const message = { ...sample, sequence, serverNow: ++now };
      oneFrame.append(message, json(message));
    }
    expect(oneFrame.index().frames.map(({ sequence }) => sequence)).toEqual([3]);
    expect(oneFrame.seed(oneFrame.index().generation, now)?.reduce((n, frame) => n + frame.decodedBytes, 2)).toBeLessThanOrEqual(frameBytes + 2);
    oneFrame.append({ ...sample, sequence: 4, serverNow: ++now }, json(sample).repeat(2));
    expect(oneFrame.index().frames).toHaveLength(0);
    for (const h of [archive, oneFrame, hub]) h.close();
  });

  it('retains a full 60 minutes and ten-minute seed at 12,000 aircraft and 30-second cadence', () => {
    let now = T;
    const hub = new SnapshotHub({
      mode: 'replay', pollIntervalS: 30, authenticated: false, heartbeatMs: 15_000, now: () => now,
      routes: loadRouteDatabase(join(import.meta.dirname, 'fixtures/routes/routes.json')),
    });
    const snapshot = first!.snapshot;
    // Vary attributes deterministically so identical clones cannot dominate compression.
    const fleet = Array.from({ length: 12_000 }, (_, i) => {
      const a = snapshot.aircraft[i % snapshot.aircraft.length]!;
      return {
        ...a,
        icao24: i.toString(16).padStart(6, '0'),
        callsign: i % 4 === 0 ? `SYNTH${(Math.imul(i, 9_999_991) >>> 0).toString(36).toUpperCase()}` : a.callsign,
        lat: a.lat + Math.sin(i) / 3,
        lon: a.lon + Math.cos(i) / 3,
        velocity: 200 + (i % 200) / 10,
      };
    });
    for (let i = 0; i <= 120; i++) {
      now = T + i * 30_000;
      hub.publishSnapshot(shiftSnapshot({ ...snapshot, aircraft: fleet }, now / 1000 - snapshot.time));
    }
    const { generation, frames } = hub.history.index();
    expect(frames).toHaveLength(121);
    expect(frames[0]?.capturedAt).toBe(now - HISTORY_WINDOW_MS);
    const seed = hub.history.seed(generation, now)!;
    expect(seed).toHaveLength(21);
    expect(seed.reduce((n, frame) => n + frame.gzip.length, 0)).toBeLessThan(16 * 1024 * 1024);
    expect(seed.reduce((n, frame) => n + frame.decodedBytes, 0)).toBeLessThan(40 * 1024 * 1024);
    hub.close();
  }, 20_000);

  it('serves bounded index, seed and individual frames over HTTP with no upstream', async () => {
    let now = T;
    const hub = makeHub(() => now);
    const initial = hub.publishSnapshot(first!.snapshot);
    now += 20_000;
    const next = hub.publishSnapshot(second!.snapshot);
    const server = createApp({ hub });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/history`;
    try {
      const index = (await (await fetch(base)).json()) as HistoryIndex;
      expect(index.frames).toEqual([
        { sequence: 1, capturedAt: T, replayEpoch: 0 },
        { sequence: 2, capturedAt: now, replayEpoch: 0 },
      ]);
      const path = `${base}/${index.generation}`;
      const bundle = await fetch(`${path}?at=${now}`);
      expect(bundle.headers.get('cache-control')).toBe('no-store');
      expect(bundle.headers.get('content-encoding')).toBe('gzip');
      expect(await bundle.json()).toEqual([initial, next]);
      const identity = await fetch(`${path}?at=${now}`, { headers: { 'Accept-Encoding': 'gzip;q=0, identity' } });
      expect(identity.headers.get('content-encoding')).toBeNull();
      expect(await identity.json()).toEqual([initial, next]);
      expect(await (await fetch(`${path}/1`)).json()).toEqual(initial);
      const head = await fetch(`${path}/1`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect((await fetch(`${path}?at=broken`)).status).toBe(400);
      now = T + HISTORY_WINDOW_MS + 1;
      expect((await fetch(`${path}/1`)).status).toBe(404);
      expect((await fetch(`${path}/2`)).status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hub.close();
    }
  });
});
