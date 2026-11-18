import { haversineDistance } from './geo';

export interface RouteAirport {
  icao: string;
  iata: string | null;
  name: string;
  lat: number;
  lon: number;
}

/** Scheduled airport sequence for a callsign (origin first, destination last); not an ATC flight plan. */
export interface FlightRoute {
  airports: RouteAirport[];
}

/** Compact airport form used on the wire: name, IATA code, latitude, longitude. */
export type WireAirport = [name: string, iata: string | null, lat: number, lon: number];

/** Airport ICAO codes joined by "-", e.g. "EDDF-KJFK", as stored in the route database. */
export type RouteCodes = string;

export function decodeRoute(codes: RouteCodes, airports: Readonly<Record<string, WireAirport>>): FlightRoute | null {
  const list: RouteAirport[] = [];
  for (const icao of codes.split('-')) {
    const a = airports[icao];
    if (!a) return null;
    list.push({ icao, name: a[0], iata: a[1], lat: a[2], lon: a[3] });
  }
  return list.length >= 2 ? { airports: list } : null;
}

/**
 * Whether a position is plausibly on the route: near the great circle of at least one
 * leg (detour under 300 km or 20% of the leg). Rejects callsigns reused for another
 * leg or flight and stale database entries.
 */
export function routeFits(route: FlightRoute, position: { lat: number; lon: number }): boolean {
  for (let i = 1; i < route.airports.length; i++) {
    const a = route.airports[i - 1]!;
    const b = route.airports[i]!;
    const length = haversineDistance(a.lat, a.lon, b.lat, b.lon);
    const via =
      haversineDistance(a.lat, a.lon, position.lat, position.lon) +
      haversineDistance(position.lat, position.lon, b.lat, b.lon);
    if (via - length < Math.max(300_000, length * 0.2)) return true;
  }
  return false;
}
