import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeRoute, routeFits, type Aircraft, type RouteCodes, type WireAirport } from '@flight/shared';

export const ROUTES_FORMAT = 'flight-routes-v1';

/** On-disk route database built by `npm run routes:update` (gzip-compressed JSON). */
export interface RouteFile {
  format: typeof ROUTES_FORMAT;
  source: string;
  license: string;
  generatedAt: string;
  /** ICAO code -> [name, IATA, lat, lon]. Only airports referenced by a route. */
  airports: Record<string, WireAirport>;
  /** Callsign -> airport ICAO codes joined by "-". */
  routes: Record<string, RouteCodes>;
}

export interface RouteMatch {
  /** Route codes per aircraft (same order as the input), or null when unknown or implausible. */
  codes: (RouteCodes | null)[];
  /** Airports referenced by the matched routes. */
  airports: Record<string, WireAirport>;
}

/** Offline callsign -> scheduled route lookup. No network access at runtime. */
export class RouteDatabase {
  private readonly routes: Readonly<Record<string, RouteCodes>>;
  readonly airports: Readonly<Record<string, WireAirport>>;
  readonly generatedAt: string;

  constructor(file: RouteFile) {
    if (file.format !== ROUTES_FORMAT) throw new Error(`Unsupported route file format "${String(file.format)}"`);
    this.routes = file.routes;
    this.count = Object.keys(file.routes).length;
    this.airports = file.airports;
    this.generatedAt = file.generatedAt;
  }

  readonly count: number;

  /** Route for an aircraft, only when its current position lies plausibly along it. */
  codesFor(a: Pick<Aircraft, 'callsign' | 'lat' | 'lon'>): RouteCodes | null {
    if (!a.callsign) return null;
    if (!Object.hasOwn(this.routes, a.callsign)) return null;
    const codes = this.routes[a.callsign]!;
    const route = decodeRoute(codes, this.airports);
    return route && routeFits(route, a) ? codes : null;
  }

  match(aircraft: readonly Aircraft[]): RouteMatch {
    const airports: Record<string, WireAirport> = {};
    const codes = aircraft.map((a) => {
      const c = this.codesFor(a);
      if (c) for (const icao of c.split('-')) airports[icao] = this.airports[icao]!;
      return c;
    });
    return { codes, airports };
  }
}

/** Loads a route file (`.json` or `.json.gz`). */
export function loadRouteDatabase(path: string): RouteDatabase {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return new RouteDatabase(JSON.parse(text) as RouteFile);
}
