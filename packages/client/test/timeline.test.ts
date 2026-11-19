import { parseOpenSkyStates, toWire, type HistoryIndex, type SnapshotMessage } from '@flight/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import firstFixture from '../../server/test/fixtures/replay/fixture-0.json';
import { FlightStore } from '../src/data/flightStore';
import { TimelineController } from '../src/timeline/TimelineController';

const T = 1_800_000_000_000;
const fleet = parseOpenSkyStates(firstFixture.response).snapshot.aircraft;
const generation = 'fixture-generation';

function makeFrame(sequence: number, seconds: number, replayEpoch = 0): SnapshotMessage {
  const serverNow = T + seconds * 1000;
  return {
    mode: 'replay', sequence, time: serverNow / 1000, serverNow, replayEpoch, pollIntervalS: 180, airports: {},
    aircraft: fleet.map((a) => toWire({ ...a, timePosition: serverNow / 1000, lastContact: serverNow / 1000 })),
  };
}

function setup() {
  const first = makeFrame(1, 0);
  const second = makeFrame(2, 20);
  const loop = makeFrame(3, 40, 1);
  const frames = [first, second, loop];
  const index = (): HistoryIndex => ({
    generation,
    serverNow: Date.now(),
    frames: frames.map(({ sequence, serverNow, replayEpoch }) => ({ sequence, capturedAt: serverNow, replayEpoch })),
  });
  const api = {
    index: vi.fn(async (_signal: AbortSignal) => index()),
    seek: vi.fn(async (_generation: string, at: number, _signal: AbortSignal) => frames.filter((f) => f.serverNow <= at)),
    frame: vi.fn(async (_generation: string, sequence: number, _signal: AbortSignal) => frames.find((f) => f.sequence === sequence)!),
  };
  const live = new FlightStore();
  const onPresented = vi.fn();
  const controller = new TimelineController(live, onPresented, api, Date.now);
  controller.ingest(loop);
  return { controller, live, onPresented, api, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T + 60_000);
});
afterEach(() => vi.useRealTimers());

it('seeds chronologically, advances at the selected speed, and resets across a replay epoch', async () => {
  const { controller, live, onPresented, api, frames } = setup();
  const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  const [, second] = frames;
  controller.seek(second!.serverNow + 1000);
  expect(controller.getView()).toMatchObject({ phase: 'live', target: second!.serverNow + 1000 });
  expect(controller.store).toBe(live);
  await vi.advanceTimersByTimeAsync(160);
  const historical = controller.store;
  expect(historical).not.toBe(live);
  expect(historical.lastSequence).toBe(2);
  expect(historical.get('4ca1b2')?.appliedAt).toBe(T / 1000 + 20);
  expect(historical.now()).toBe(T / 1000 + 21);
  expect(onPresented.mock.calls).toEqual([[live], [historical]]);

  const nextLive = makeFrame(4, 60, 1);
  controller.syncLiveClock(nextLive.serverNow + 500);
  controller.ingest(nextLive);
  expect(live.lastSequence).toBe(4);
  expect(historical.lastSequence).toBe(2);
  expect(historical.now()).toBe(T / 1000 + 21);

  controller.setSpeed(4);
  controller.play();
  await vi.advanceTimersByTimeAsync(1000);
  expect(historical.now()).toBe(T / 1000 + 25);
  expect(api.frame).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4100);
  expect(historical.lastSequence).toBe(3);
  expect(historical.replayEpoch).toBe(1);
  expect(historical.get('4ca1b2')?.correctionFrom).toBeNull();
  expect(api.seek).toHaveBeenCalledOnce();
  expect(api.frame).toHaveBeenCalledExactlyOnceWith(generation, 3, expect.any(AbortSignal));
  controller.pause();
  const frozen = historical.now();
  await vi.advanceTimersByTimeAsync(1000);
  expect(historical.now()).toBe(frozen);
  controller.goLive();
  expect(controller.store).toBe(live);
  expect(controller.store.lastSequence).toBe(4);
  stop();
});

it('debounces rapid scrubs and never presents superseded or cancelled responses', async () => {
  const { controller, live, api, frames } = setup();
  let finish!: (frames: SnapshotMessage[]) => void;
  api.seek.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  controller.seek(T);
  controller.seek(T + 1);
  controller.seek(T + 2);
  await vi.advanceTimersByTimeAsync(160);
  expect(api.seek).toHaveBeenCalledExactlyOnceWith(generation, T + 2, expect.any(AbortSignal));
  const signal = api.seek.mock.calls[0]![2];
  controller.seek(T + 21_000);
  expect(signal.aborted).toBe(true);
  finish([frames[0]!]);
  await vi.advanceTimersByTimeAsync(160);
  expect(controller.store.lastSequence).toBe(2);
  expect(controller.getView().target).toBeNull();

  controller.seek(T);
  controller.goLive();
  await vi.advanceTimersByTimeAsync(160);
  expect(api.seek).toHaveBeenCalledTimes(2);
  expect(controller.store).toBe(live);
  stop();
});
