import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { destinationPoint, estimateTrack, nextTrack, toWire, type Aircraft, type MotionTrack, type SnapshotMessage } from '@flight/shared';
import { FlightStore } from '../src/data/flightStore';
import { FLEET_TRAIL_S, SELECTED_TRAIL_S, TrailHistory } from '../src/data/trailHistory';
import { TrailLayer } from '../src/globe/trailLayer';

const T = 1_700_000_000;

function plane(appliedAt: number, id = 'test01', lat = 0, lon = 179.98): Aircraft {
  const p = destinationPoint(lat, lon, 90, (appliedAt - T) * 240);
  return {
    ...p, icao24: id, callsign: id, originCountry: 'Synthetic', timePosition: appliedAt, lastContact: appliedAt,
    altitude: 10_000, velocity: 240, heading: 90, verticalRate: 0,
  };
}

function collect(history: TrailHistory, id: string, now: number, span = SELECTED_TRAIL_S) {
  const ranges: { start: number; end: number; current: boolean; track: MotionTrack }[] = [];
  history.visit(id, now, span, (track, start, end, current) => {
    ranges.push({ track, start, end, current });
    return true;
  });
  return ranges;
}

function message(sequence: number, time: number, replayEpoch = 0): SnapshotMessage {
  return {
    sequence, mode: 'replay', replayEpoch, time, serverNow: time * 1000, pollIntervalS: 20,
    aircraft: [toWire(plane(time), null)], airports: {},
  };
}

describe('trail history', () => {
  it('bounds history by time and number of sections and keeps motion within the display window', () => {
    const history = new TrailHistory();
    for (let i = 0; i < 100; i++) history.replace([nextTrack(undefined, plane(T + i), T + i)], T + i);
    expect(collect(history, 'test01', T + 100)).toHaveLength(48);

    // Rebuild the journal for a seek without requiring stored routes or mutating live history.
    const seekStore = new FlightStore(() => 0);
    for (let i = 0; i < 10; i++) seekStore.applySnapshot(message(i, T + i * 80));
    const seek = seekStore.trailHistory;
    const selected = collect(seek, 'test01', T + 740);
    expect(selected[0]).toMatchObject({ end: T + 740, current: true });
    expect(selected.at(-1)?.start).toBe(T + 740 - SELECTED_TRAIL_S);
    const short = collect(seek, 'test01', T + 740, FLEET_TRAIL_S);
    expect(short.at(-1)?.start).toBe(T + 740 - FLEET_TRAIL_S);
    expect(collect(seek, 'test01', T + 695)[0]).toMatchObject({ end: T + 695, current: false });
    expect(collect(history, 'test01', T + 100)).toHaveLength(48);
  });

  it('breaks on disappearance, rollback, and replay epochs', () => {
    const store = new FlightStore(() => 0);
    store.applySnapshot(message(1, T));
    store.applySnapshot(message(2, T + 20));
    expect(collect(store.trailHistory, 'test01', T + 22)).toHaveLength(2);
    const version = store.trailHistory.version;
    expect(store.applySnapshot(message(2, T + 20))).toBe('duplicate');
    expect(store.trailHistory.version).toBe(version);
    store.applySnapshot({ ...message(3, T + 40), aircraft: [] });
    expect(collect(store.trailHistory, 'test01', T + 42)).toEqual([]);
    store.applySnapshot(message(4, T + 60));
    expect(collect(store.trailHistory, 'test01', T + 64)).toMatchObject([{ start: T + 60 }]);
    store.applySnapshot(message(5, T + 80));
    store.applySnapshot(message(6, T + 100, 1));
    expect(collect(store.trailHistory, 'test01', T + 103)).toMatchObject([{ start: T + 100 }]);
    store.applySnapshot(message(7, T + 90, 1));
    expect(collect(store.trailHistory, 'test01', T + 103)).toMatchObject([{ start: T + 90 }]);
  });

  it('retains corrections even if the renderer consumes them, and trims stale motion', () => {
    const history = new TrailHistory();
    const first = nextTrack(undefined, plane(T), T);
    const second = nextTrack(first, { ...plane(T + 30), lon: -179.8 }, T + 30);
    expect(second.correctionFrom).not.toBeNull();
    history.replace([first], T);
    history.replace([second], T + 30);
    estimateTrack(second, T + 34);
    expect(second.correctionFrom).toBeNull();
    const ranges = collect(history, 'test01', T + 400);
    expect(ranges[0]?.track.correctionFrom).not.toBeNull();
    expect(ranges[0]).toMatchObject({ end: T + 330, current: false });
    expect(collect(history, 'test01', T + 1000)).toEqual([]);
  });
});

describe('trail layer', () => {
  it('uses only displayed tracks and invalidates caches on store changes and seeks', () => {
    const live = new TrailHistory();
    const seek = new TrailHistory();
    const a = nextTrack(undefined, plane(T), T);
    const b = nextTrack(undefined, plane(T, 'test02', 21, 4), T);
    live.replace([a, b], T);
    seek.replace([a], T);
    const layer = new TrailLayer();
    const positions = new THREE.DataTexture();
    const draw = (history: TrailHistory, tracks: MotionTrack[], key: string, now: number, fleet: boolean) =>
      layer.update({ history, tracks, key, now, selectedId: a.aircraft.icao24, fleet, positions });

    draw(live, [a, b], 'full', T + 35, false);
    expect(layer.selectedSegments).toBeGreaterThan(1);
    expect(layer.fleetSegments).toBe(0);
    draw(live, [a, b], 'full', T + 35, true);
    expect(layer.fleetSegments).toBeGreaterThan(1);
    draw(live, [b], 'filtered', T + 35, true);
    expect(layer.selectedSegments).toBe(0);
    expect(layer.fleetSegments).toBeGreaterThan(1);
    expect(layer.lines.geometry.getAttribute('aTrail').getY(1)).toBe(0);
    draw(seek, [b], 'filtered', T + 35, true);
    expect(layer.lines.visible).toBe(false);
    draw(live, [a], 'full', T + 35, false);
    expect(layer.lines.visible).toBe(true);
    draw(live, [a], 'full', T - 1, false);
    expect(layer.lines.visible).toBe(false);
    layer.dispose();
    positions.dispose();
  });

  it('takes the short path across the antimeridian and never spans a snapped correction', () => {
    const history = new TrailHistory();
    const first = nextTrack(undefined, plane(T), T);
    const next = nextTrack(first, plane(T + 30, 'test01', 52, 10), T + 30);
    expect(next.correctionFrom).toBeNull();
    history.replace([first], T);
    history.replace([next], T + 30);
    const layer = new TrailLayer();
    const positions = new THREE.DataTexture();
    layer.update({ history, tracks: [next], selectedId: 'test01', key: 'test', now: T + 52, fleet: false, positions });
    const attr = layer.lines.geometry.getAttribute('position');
    expect(layer.selectedSegments).toBeGreaterThanOrEqual(5);
    for (let i = 2; i < layer.lines.geometry.drawRange.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(attr, i);
      const b = new THREE.Vector3().fromBufferAttribute(attr, i + 1);
      expect(a.distanceTo(b)).toBeLessThan(0.001);
    }
    layer.dispose();
    positions.dispose();
  });
});
