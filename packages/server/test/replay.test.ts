import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromWire } from '@flight/shared';
import { SnapshotHub } from '../src/hub';
import { ReplaySource, loadRecordings, shiftSnapshot } from '../src/replay';

const FIXTURES = join(import.meta.dirname, 'fixtures/replay');

describe('loadRecordings', () => {
  it('loads recorder-format files sorted by time and applies the airborne filter', () => {
    const recs = loadRecordings(FIXTURES);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.snapshot.time)).toEqual([1_700_000_000, 1_700_000_020, 1_700_000_040]);
    // The fixture includes one grounded aircraft and one without a position.
    expect(recs[0]!.snapshot.aircraft).toHaveLength(8);
  });

  it('accepts raw OpenSky responses and skips unreadable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ time: 20, states: [] }));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ time: 10, states: [] }));
    writeFileSync(join(dir, 'broken.json'), '{');
    const warn = vi.fn();
    const recs = loadRecordings(dir, warn);
    expect(recs.map((r) => r.snapshot.time)).toEqual([10, 20]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails clearly when there is nothing to replay', () => {
    expect(() => loadRecordings(mkdtempSync(join(tmpdir(), 'empty-')))).toThrow(/No usable recordings/);
    expect(() => loadRecordings('/definitely/missing')).toThrow(/not found/);
  });
});

describe('ReplaySource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays on a replay clock and starts a new epoch when the recording loops', async () => {
    const recordings = loadRecordings(FIXTURES);
    const hub = new SnapshotHub({ mode: 'replay', pollIntervalS: 180, authenticated: false, heartbeatMs: 15_000 });
    const published = vi.spyOn(hub, 'publishSnapshot');
    const replay = new ReplaySource({ recordings, hub });
    expect(replay.loopGapS).toBe(20);
    const start = Date.now() / 1000;
    replay.start();

    expect(published).toHaveBeenCalledTimes(1);
    const first = hub.latestSnapshot!;
    expect(first.time).toBeCloseTo(start);
    expect(first.replayEpoch).toBe(0);
    // Observation timestamps move with the replay clock, preserving their offsets.
    expect(fromWire(first.aircraft[0]!).timePosition).toBeCloseTo(start - 1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.latestSnapshot!.time).toBeCloseTo(start + 20);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.latestSnapshot!.time).toBeCloseTo(start + 40);
    expect(hub.latestSnapshot!.replayEpoch).toBe(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.latestSnapshot!.replayEpoch).toBe(1);
    expect(hub.latestSnapshot!.time).toBeCloseTo(start + 60);
    expect(published).toHaveBeenCalledTimes(4);
    replay.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(published).toHaveBeenCalledTimes(4);
  });

  it('shifts every timestamp without mutating the recording', () => {
    const snap = loadRecordings(FIXTURES)[0]!.snapshot;
    const shifted = shiftSnapshot(snap, 100);
    expect(shifted.time).toBe(snap.time + 100);
    expect(shifted.aircraft[0]!.timePosition).toBe(snap.aircraft[0]!.timePosition + 100);
    expect(snap.time).toBe(1_700_000_000);
  });
});
