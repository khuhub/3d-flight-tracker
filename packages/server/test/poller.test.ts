import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotHub } from '../src/hub';
import { OpenSkyError, type StatesResponse } from '../src/opensky';
import { LivePoller } from '../src/poller';

const T = 1_700_000_000;
const body = (t: number) => ({ time: t, states: [['abc123', 'X1', 'Y', t, t, 1, 2, 9000, false, 200, 90, 0, null, 9000, null, false, 0]] });

function setup(fetchAllStates: () => Promise<StatesResponse>, intervalS = 180, maxBackoffS = 3600) {
  const hub = new SnapshotHub({ mode: 'live', pollIntervalS: intervalS, authenticated: true, heartbeatMs: 15_000 });
  const client = { fetchAllStates: vi.fn(fetchAllStates) };
  const poller = new LivePoller({ client, hub, intervalS, maxBackoffS });
  return { hub, client, poller };
}

describe('LivePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately, then every interval, publishing filtered snapshots', async () => {
    let t = T;
    const { hub, client, poller } = setup(async () => ({ body: body(t++), creditsRemaining: 3996 }));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.fetchAllStates).toHaveBeenCalledTimes(1);
    expect(hub.latestSnapshot?.aircraft).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(client.fetchAllStates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.fetchAllStates).toHaveBeenCalledTimes(2);
    expect(hub.getStatus()).toMatchObject({ upstream: 'ok', lastError: null });
    poller.stop();
  });

  it('never overlaps requests, even when one is slower than the interval', async () => {
    let resolve!: (r: StatesResponse) => void;
    const { client, poller } = setup(() => new Promise<StatesResponse>((r) => (resolve = r)), 30);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await poller.pollOnce()).toBe(-1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.fetchAllStates).toHaveBeenCalledTimes(1);
    resolve({ body: body(T), creditsRemaining: null });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.fetchAllStates).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('keeps the last good snapshot and backs off exponentially on failures', async () => {
    let fail = false;
    const { hub, poller } = setup(async () => {
      if (fail) throw new OpenSkyError('OpenSky returned HTTP 503', 'http', 503);
      return { body: body(T), creditsRemaining: null };
    }, 180, 1000);
    await poller.pollOnce();
    const good = hub.latestSnapshot;
    fail = true;
    const delays = [];
    for (let i = 0; i < 5; i++) delays.push(await poller.pollOnce());
    expect(delays).toEqual([180_000, 360_000, 720_000, 1_000_000, 1_000_000]);
    expect(hub.latestSnapshot).toBe(good);
    expect(hub.getStatus()).toMatchObject({ upstream: 'error', lastError: 'OpenSky returned HTTP 503' });
    fail = false;
    expect(await poller.pollOnce()).toBe(180_000);
    expect(poller.consecutiveFailures).toBe(0);
    poller.stop();
  });

  it('honours the rate-limit retry delay even beyond the normal backoff cap', async () => {
    const { hub, poller } = setup(async () => {
      throw new OpenSkyError('OpenSky rate limit reached (HTTP 429)', 'rate-limit', 429, 7200);
    }, 180, 600);
    expect(await poller.pollOnce()).toBe(7_200_000);
    expect(hub.getStatus().upstream).toBe('rate-limited');
    poller.stop();
  });

  it('treats malformed responses as failures', async () => {
    const { hub, poller } = setup(async () => ({ body: { nope: true }, creditsRemaining: null }));
    expect(await poller.pollOnce()).toBe(180_000);
    expect(hub.getStatus().upstream).toBe('error');
    expect(hub.latestSnapshot).toBeNull();
  });
});
