import { describe, expect, it } from 'vitest';
import { toWire, type Aircraft, type SnapshotMessage, type WireAirport } from '@flight/shared';
import { FlightStore } from '../src/data/flightStore';

const T = 1_700_000_000;
const AIRPORTS: Record<string, WireAirport> = {
  EGLL: ['London Heathrow', 'LHR', 51.4706, -0.4619],
  EDDF: ['Frankfurt am Main', 'FRA', 50.0264, 8.5431],
};

function plane(id: string, t: number, lon: number): Aircraft {
  return { icao24: id, callsign: id.toUpperCase(), originCountry: 'X', timePosition: t, lastContact: t, lat: 50, lon, altitude: 10_000, velocity: 230, heading: 90, verticalRate: 0 };
}

function message(
  seq: number,
  t: number,
  aircraft: Aircraft[],
  routes: Record<string, string> = {},
  replayEpoch = 0,
  mode: 'live' | 'replay' = 'replay',
): SnapshotMessage {
  return {
    mode,
    sequence: seq,
    replayEpoch,
    time: t,
    serverNow: t * 1000,
    pollIntervalS: 180,
    aircraft: aircraft.map((a) => toWire(a, routes[a.icao24] ?? null)),
    airports: AIRPORTS,
  };
}

describe('FlightStore', () => {
  it('follows the server clock and shows only aircraft in the latest snapshot', () => {
    let wall = 0;
    const store = new FlightStore(() => wall);
    expect(store.applySnapshot(message(1, T, [plane('a', T, 0), plane('b', T, 1)]))).toBe('applied');
    expect(store.now()).toBeCloseTo(T);
    wall += 180_000;
    store.applySnapshot(message(2, T + 180, [plane('a', T + 180, 0.6)]));
    expect(store.tracks.map((t) => t.aircraft.icao24)).toEqual(['a']);
    expect(store.get('b')).toBeUndefined();
  });

  it('decodes each aircraft route from the snapshot and keeps it fixed between snapshots', () => {
    const store = new FlightStore(() => 0);
    store.applySnapshot(message(1, T, [plane('a', T, 2), plane('b', T, 3)], { a: 'EGLL-EDDF' }));
    const route = store.routes.get('a')!;
    expect(route.codes).toBe('EGLL-EDDF');
    expect(route.route.airports.map((x) => [x.icao, x.iata, x.name])).toEqual([
      ['EGLL', 'LHR', 'London Heathrow'],
      ['EDDF', 'FRA', 'Frankfurt am Main'],
    ]);
    expect(store.routes.has('b')).toBe(false);
    // The aircraft moves but its route is the same: no rebuild is triggered.
    const version = store.routesVersion;
    store.applySnapshot(message(2, T + 180, [plane('a', T + 180, 3), plane('b', T + 180, 4)], { a: 'EGLL-EDDF' }));
    expect(store.routesVersion).toBe(version);
    expect(store.routes.get('a')!.route.airports).toHaveLength(2);
    // Aircraft that disappear take their route with them.
    store.applySnapshot(message(3, T + 360, [plane('b', T + 360, 5)]));
    expect(store.routesVersion).toBe(version + 1);
    expect(store.routes.size).toBe(0);
  });

  it('drops routes that reference airports missing from the message', () => {
    const store = new FlightStore(() => 0);
    store.applySnapshot(message(1, T, [plane('a', T, 2)], { a: 'EGLL-KJFK' }));
    expect(store.routes.size).toBe(0);
  });

  it('ignores re-delivered snapshots after a reconnect', () => {
    const store = new FlightStore(() => 0);
    const m = message(7, T, [plane('a', T, 0)]);
    store.applySnapshot(m);
    const version = store.version;
    expect(store.applySnapshot(m)).toBe('duplicate');
    expect(store.version).toBe(version);
  });

  it('resets motion when the replay loops, time runs backwards or the mode changes', () => {
    const store = new FlightStore(() => 0);
    store.applySnapshot(message(1, T, [plane('a', T, 0)]));
    store.applySnapshot(message(2, T + 180, [plane('a', T + 180, 0.6)]));
    expect(store.applySnapshot(message(3, T + 540, [plane('a', T + 540, 0)], {}, 1))).toBe('reset');
    expect(store.tracks[0]!.correctionFrom).toBeNull();
    expect(store.applySnapshot(message(4, T, [plane('a', T, 0)], {}, 1))).toBe('reset');
    expect(store.applySnapshot(message(5, T + 900, [plane('a', T + 900, 0)], {}, 1, 'live'))).toBe('reset');
  });
});
