import { describe, expect, it } from 'vitest';
import { nextTrack, unitVector, vectorToLatLon, type Aircraft, type FlightRoute, type Vec3 } from '@flight/shared';
import { buildRouteVertices, currentLeg, routeVertexPosition, type DisplayRoute } from '../src/globe/routeLayer';
import { altitudeToRadius } from '../src/globe/coords';

const T = 1_700_000_000;
const airport = (icao: string, lat: number, lon: number) => ({ icao, iata: null, name: icao, lat, lon });
const LHR = airport('EGLL', 51.47, -0.46);
const JFK = airport('KJFK', 40.64, -73.78);
const LAX = airport('KLAX', 33.94, -118.41);

function plane(id: string, lat: number, lon: number, altitude = 10_000): Aircraft {
  return { icao24: id, callsign: id, originCountry: 'X', timePosition: T, lastContact: T, lat, lon, altitude, velocity: 230, heading: 270, verticalRate: 0 };
}

/** World position where the aircraft layer draws an aircraft (same formula as aircraftLayer). */
function drawn(a: Aircraft): Vec3 {
  const u = unitVector(a.lat, a.lon);
  const r = altitudeToRadius(a.altitude);
  return [u[0] * r, u[1] * r, u[2] * r];
}

/** Evaluates every built vertex like the shader does. */
function evaluate(fleet: Aircraft[], routes: Map<string, DisplayRoute>, only: string | null = null) {
  const tracks = fleet.map((a) => nextTrack(undefined, a, T));
  const v = buildRouteVertices(tracks, routes, only);
  const pts: { p: Vec3; index: number; f: number }[] = [];
  for (let i = 0; i < v.vertexCount; i++) {
    const start = Array.from(v.start.subarray(i * 3, i * 3 + 3)) as Vec3;
    const end = Array.from(v.end.subarray(i * 3, i * 3 + 3)) as Vec3;
    const index = v.index[i]!;
    pts.push({ p: routeVertexPosition(start, end, v.fraction[i]!, index >= 0 ? drawn(fleet[index]!) : null), index, f: v.fraction[i]! });
  }
  return { v, pts };
}

const route = (codes: string, ...airports: ReturnType<typeof airport>[]): DisplayRoute => ({ codes, route: { airports } });

describe('route geometry: departure → aircraft → arrival', () => {
  it('runs from each airport on the ground to exactly where the aircraft is drawn', () => {
    const a = plane('a', 55, -30); // mid-Atlantic, north of the direct great circle
    const { v, pts } = evaluate([a], new Map([['a', route('EGLL-KJFK', LHR, JFK)]]));
    expect(v.vertexCount % 2).toBe(0);
    expect(pts.every((x) => x.index === 0)).toBe(true);
    const ends = pts.filter((x) => x.f === 0).map((x) => vectorToLatLon(...x.p));
    expect(ends.some((e) => Math.abs(e.lat - LHR.lat) < 1e-3 && Math.abs(e.lon - LHR.lon) < 1e-3)).toBe(true);
    expect(ends.some((e) => Math.abs(e.lat - JFK.lat) < 1e-3 && Math.abs(e.lon - JFK.lon) < 1e-3)).toBe(true);
    for (const x of pts.filter((q) => q.f === 0)) expect(Math.hypot(...x.p)).toBeCloseTo(altitudeToRadius(0), 6);
    // Both halves end on the aircraft, so the line bends through the plane.
    const atPlane = pts.filter((x) => x.f === 1);
    expect(atPlane.length).toBe(2);
    for (const x of atPlane) for (let k = 0; k < 3; k++) expect(x.p[k]).toBeCloseTo(drawn(a)[k]!, 6);
    // Never below the surface.
    expect(Math.min(...pts.map((x) => Math.hypot(...x.p)))).toBeGreaterThanOrEqual(altitudeToRadius(0) - 1e-6);
  });

  it('follows the aircraft as it moves without changing the geometry size', () => {
    const routes = new Map([['a', route('EGLL-KJFK', LHR, JFK)]]);
    const first = evaluate([plane('a', 52, -20)], routes);
    const later = evaluate([plane('a', 50, -40)], routes);
    expect(later.v.vertexCount).toBe(first.v.vertexCount);
    const end = later.pts.find((x) => x.f === 1)!.p;
    const ll = vectorToLatLon(...end);
    expect(ll.lat).toBeCloseTo(50, 4);
    expect(ll.lon).toBeCloseTo(-40, 4);
  });

  it('splits only the leg being flown on multi-stop routes', () => {
    const r: FlightRoute = { airports: [LHR, JFK, LAX] };
    expect(currentLeg(r, 45, -40)).toBe(0);
    expect(currentLeg(r, 38, -95)).toBe(1);
    const { pts } = evaluate([plane('a', 38, -95)], new Map([['a', route('EGLL-KJFK-KLAX', LHR, JFK, LAX)]]));
    // First leg is a fixed airport arc; the second is split at the aircraft.
    expect(pts.some((x) => x.index === -1)).toBe(true);
    expect(pts.filter((x) => x.index === 0 && x.f === 1)).toHaveLength(2);
    const fixed = pts.filter((x) => x.index === -1);
    // The London-New York great circle bulges north of both airports.
    expect(Math.max(...fixed.map((x) => vectorToLatLon(...x.p).lat))).toBeGreaterThan(52);
  });

  it('crosses the antimeridian the short way', () => {
    const anc = airport('PANC', 61.17, -149.99);
    const pkc = airport('UHPP', 53.17, 158.45);
    const { pts } = evaluate([plane('a', 60, 179.95)], new Map([['a', route('UHPP-PANC', pkc, anc)]]));
    expect(pts.every((x) => Math.abs(vectorToLatLon(...x.p).lon) > 140)).toBe(true);
  });

  it('builds only the requested aircraft and skips aircraft without routes', () => {
    const fleet = [plane('a', 55, -30), plane('b', 10, 10)];
    const routes = new Map([['a', route('EGLL-KJFK', LHR, JFK)]]);
    expect(evaluate(fleet, routes, 'b').v.vertexCount).toBe(0);
    expect(evaluate(fleet, routes, 'a').v.vertexCount).toBe(evaluate(fleet, routes).v.vertexCount);
  });
});
