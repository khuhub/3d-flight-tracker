import type { RouteCodes, WireAirport } from './routes';

export type FlightMode = 'live' | 'replay';

/** One airborne aircraft with a validated position, as kept by the backend. */
export interface Aircraft {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  /** Unix seconds of the position report. */
  timePosition: number;
  /** Unix seconds of the last message of any kind. */
  lastContact: number;
  lat: number;
  lon: number;
  /** Metres; barometric when available, otherwise geometric. */
  altitude: number | null;
  /** Ground speed in m/s. */
  velocity: number | null;
  /** True track in degrees clockwise from north. */
  heading: number | null;
  /** m/s, positive when climbing. */
  verticalRate: number | null;
}

export interface Snapshot {
  /** Unix seconds the state vectors are associated with. */
  time: number;
  aircraft: Aircraft[];
}

/** Compact tuple form used on the wire to keep 10k+ aircraft payloads small. */
export type WireAircraft = [
  icao24: string,
  callsign: string | null,
  originCountry: string,
  timePosition: number,
  lastContact: number,
  lat: number,
  lon: number,
  altitude: number | null,
  velocity: number | null,
  heading: number | null,
  verticalRate: number | null,
  /** Scheduled route as airport ICAO codes ("EDDF-KJFK"), null when unknown or implausible. */
  route?: RouteCodes | null,
];

export interface SnapshotMessage {
  mode: FlightMode;
  /** Monotonic per server process. */
  sequence: number;
  /** Increments whenever replay loops; clients must reset motion state when it changes. */
  replayEpoch: number;
  /** Unix seconds of the snapshot data (already shifted onto the replay clock in replay mode). */
  time: number;
  /** Server wall clock (ms) when the message was produced. */
  serverNow: number;
  pollIntervalS: number;
  aircraft: WireAircraft[];
  /** Airports referenced by `route` entries in `aircraft`: ICAO -> [name, IATA, lat, lon]. */
  airports: Record<string, WireAirport>;
}

export type UpstreamState = 'starting' | 'ok' | 'error' | 'rate-limited';

export interface StatusMessage {
  mode: FlightMode;
  upstream: UpstreamState;
  /** Server wall clock (ms) of the last successful snapshot. */
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Server wall clock (ms) of the next scheduled poll or replay step. */
  nextUpdateAt: number | null;
  pollIntervalS: number;
  authenticated: boolean;
  serverNow: number;
}

export function toWire(a: Aircraft, route: RouteCodes | null = null): WireAircraft {
  return [
    a.icao24,
    a.callsign,
    a.originCountry,
    a.timePosition,
    a.lastContact,
    round(a.lat, 5),
    round(a.lon, 5),
    a.altitude === null ? null : Math.round(a.altitude),
    a.velocity === null ? null : round(a.velocity, 1),
    a.heading === null ? null : round(a.heading, 1),
    a.verticalRate === null ? null : round(a.verticalRate, 1),
    route,
  ];
}

export function fromWire(w: WireAircraft): Aircraft {
  return {
    icao24: w[0],
    callsign: w[1],
    originCountry: w[2],
    timePosition: w[3],
    lastContact: w[4],
    lat: w[5],
    lon: w[6],
    altitude: w[7],
    velocity: w[8],
    heading: w[9],
    verticalRate: w[10],
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
