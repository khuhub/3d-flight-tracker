import { describe, expect, it } from 'vitest';
import { toWire, type Aircraft, type SnapshotMessage, type WireAirport } from '@flight/shared';
import { DEFAULT_FLIGHT_FILTERS } from '../src/data/flightFilters';
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

describe('FlightStore filters', () => {
  const visibleIds = (store: FlightStore) => store.tracks.map((track) => track.aircraft.icao24);

  it('uses unrounded reported altitude with inclusive lower bounds and a separate unknown band', () => {
    const store = new FlightStore(() => 0);
    store.applySnapshot(message(1, T, [
      { ...plane('low', T, 0), altitude: 3047 },
      { ...plane('mid-start', T, 0), altitude: 3048 },
      { ...plane('mid-end', T, 0), altitude: 9143 },
      { ...plane('high', T, 0), altitude: 9144 },
      { ...plane('unknown', T, 0), altitude: null },
    ]));
    expect(visibleIds(store)).toEqual(['low', 'mid-start', 'mid-end', 'high', 'unknown']);
    store.setFilters({ ...DEFAULT_FLIGHT_FILTERS, altitudeBand: 'low' });
    expect(visibleIds(store)).toEqual(['low']);
    store.setFilters({ ...DEFAULT_FLIGHT_FILTERS, altitudeBand: 'mid' });
    expect(visibleIds(store)).toEqual(['mid-start', 'mid-end']);
    store.setFilters({ ...DEFAULT_FLIGHT_FILTERS, altitudeBand: 'high' });
    expect(visibleIds(store)).toEqual(['high']);
    const onlyUnknown = { ...DEFAULT_FLIGHT_FILTERS, altitudeBand: 'unknown' } as const;
    store.setFilters(onlyUnknown);
    expect(visibleIds(store)).toEqual(['unknown']);
    const version = store.version;
    store.setFilters({ ...onlyUnknown });
    expect(store.version).toBe(version);
  });

  it('intersects filters and recomputes route membership and visible counts on each snapshot', () => {
    const store = new FlightStore(() => 0);
    const fleet = [
      plane('a', T, 0),
      { ...plane('b', T, 1), originCountry: 'Y' },
      { ...plane('c', T, 2), altitude: 1000 },
      plane('d', T, 3),
    ];
    store.applySnapshot(message(1, T, fleet, { a: 'EGLL-EDDF', b: 'EGLL-EDDF', c: 'EGLL-EDDF', d: 'EGLL-KJFK' }));
    const beforeFilter = store.version;
    const routesVersion = store.routesVersion;
    store.setFilters({ altitudeBand: 'high', originCountry: 'X', knownRouteOnly: true });
    expect(store.version).toBe(beforeFilter + 1);
    expect(store.routesVersion).toBe(routesVersion);
    expect(visibleIds(store)).toEqual(['a']);
    expect(store.get('a')).toBe(store.getRaw('a'));
    expect(store.get('b')).toBeUndefined();
    expect(store.getRaw('b')).toBeDefined();
    expect(store.allTracks).toHaveLength(4);
    expect(store.routes.size).toBe(3);
    expect(store.visibleRouteCount).toBe(1);

    store.applySnapshot(message(2, T + 5, fleet, { b: 'EGLL-EDDF', c: 'EGLL-EDDF', d: 'EGLL-EDDF' }));
    expect(visibleIds(store)).toEqual(['d']);
    expect(store.routes.has('a')).toBe(false);
    expect(store.visibleRouteCount).toBe(1);
    store.setFilters({ ...DEFAULT_FLIGHT_FILTERS, originCountry: 'X' });
    expect(visibleIds(store)).toEqual(['a', 'c', 'd']);
    expect(store.visibleRouteCount).toBe(2);
  });

  it('continues blending motion for hidden aircraft until a clear or time reset', () => {
    const store = new FlightStore(() => 0);
    const filters = { ...DEFAULT_FLIGHT_FILTERS, originCountry: 'X', knownRouteOnly: true };
    store.setFilters(filters);
    store.applySnapshot(message(1, T, [plane('a', T, 0)]));
    expect(store.get('a')).toBeUndefined();
    store.applySnapshot(message(2, T + 20, [plane('a', T + 20, 0.5)], { a: 'EGLL-EDDF' }));
    expect(store.get('a')?.correctionFrom).not.toBeNull();

    expect(store.applySnapshot(message(3, T, [plane('a', T, 0)]))).toBe('reset');
    expect(store.filters).toEqual(filters);
    expect(store.get('a')).toBeUndefined();
    expect(store.getRaw('a')?.correctionFrom).toBeNull();
    expect(store.applySnapshot(message(4, T + 20, [plane('a', T + 20, 0)], {}, 1))).toBe('reset');
    expect(store.get('a')).toBeUndefined();
    expect(store.applySnapshot(message(5, T + 30, [plane('a', T + 30, 0)], {}, 1, 'live'))).toBe('reset');
    expect(store.get('a')).toBeUndefined();

    store.clear();
    expect(store.filters).toEqual(filters);
    expect(store.allTracks).toEqual([]);
    expect(store.getRaw('a')).toBeUndefined();
    expect(store.routes.size).toBe(0);
    expect(store.visibleRouteCount).toBe(0);
    store.applySnapshot(message(6, T + 40, [plane('a', T + 40, 0)], { a: 'EGLL-EDDF' }, 1, 'live'));
    expect(visibleIds(store)).toEqual(['a']);
    expect(store.get('a')?.correctionFrom).toBeNull();
  });
});
