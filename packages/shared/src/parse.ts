import type { Aircraft, Snapshot } from './types';

export interface ParseStats {
  total: number;
  kept: number;
  grounded: number;
  invalid: number;
  /** Positions older than `maxPositionAgeS` at snapshot time. */
  stale: number;
  duplicates: number;
  /** Aircraft kept with their speed cleared because it was physically implausible. */
  implausibleSpeed: number;
}

export interface ParseOptions {
  /** Drop aircraft whose last position report is older than this at snapshot time. */
  maxPositionAgeS: number;
  /** Ground speeds above this are treated as unknown so they cannot drive extrapolation. */
  maxPlausibleSpeedMps: number;
}

/**
 * OpenSky keeps some aircraft for hours after their last position report, and a few
 * transponders report impossible speeds (over 2,000 m/s was seen in real recordings).
 */
export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  maxPositionAgeS: 15 * 60,
  maxPlausibleSpeedMps: 400,
};

export interface ParseResult {
  snapshot: Snapshot;
  stats: ParseStats;
}

export class OpenSkyParseError extends Error {
  override name = 'OpenSkyParseError';
}

const ICAO24 = /^[0-9a-f]{6}$/i;

/**
 * Parses an OpenSky `/states/all` response, keeping only airborne aircraft with a
 * usable timestamped position. Throws when the envelope itself is malformed.
 */
export function parseOpenSkyStates(body: unknown, options: Partial<ParseOptions> = {}): ParseResult {
  const opts = { ...DEFAULT_PARSE_OPTIONS, ...options };
  if (typeof body !== 'object' || body === null) {
    throw new OpenSkyParseError('Response is not an object');
  }
  const { time, states } = body as { time?: unknown; states?: unknown };
  if (!isFiniteNumber(time)) throw new OpenSkyParseError('Response has no numeric "time"');
  if (states !== null && states !== undefined && !Array.isArray(states)) {
    throw new OpenSkyParseError('"states" is not an array');
  }

  const stats: ParseStats = { total: 0, kept: 0, grounded: 0, invalid: 0, stale: 0, duplicates: 0, implausibleSpeed: 0 };
  const byId = new Map<string, Aircraft>();
  for (const row of (states ?? []) as unknown[]) {
    stats.total++;
    const result = parseRow(row);
    if (result === 'grounded') {
      stats.grounded++;
      continue;
    }
    if (result === null) {
      stats.invalid++;
      continue;
    }
    if (time - result.timePosition > opts.maxPositionAgeS) {
      stats.stale++;
      continue;
    }
    if (result.velocity !== null && result.velocity > opts.maxPlausibleSpeedMps) {
      result.velocity = null;
      stats.implausibleSpeed++;
    }
    const existing = byId.get(result.icao24);
    if (existing) {
      stats.duplicates++;
      if (existing.timePosition >= result.timePosition) continue;
    }
    byId.set(result.icao24, result);
  }
  const aircraft = [...byId.values()];
  stats.kept = aircraft.length;
  return { snapshot: { time, aircraft }, stats };
}

function parseRow(row: unknown): Aircraft | 'grounded' | null {
  if (!Array.isArray(row) || row.length < 11) return null;
  const [icao24, callsign, country, timePosition, lastContact, lon, lat, baroAlt, onGround, velocity, track, verticalRate] =
    row as unknown[];
  const geoAlt = row[13] as unknown;

  if (typeof icao24 !== 'string' || !ICAO24.test(icao24.trim())) return null;
  if (onGround === true) return 'grounded';
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!isFiniteNumber(timePosition) || timePosition <= 0) return null;

  const altitude = isFiniteNumber(baroAlt) ? baroAlt : isFiniteNumber(geoAlt) ? geoAlt : null;
  const name = typeof callsign === 'string' ? callsign.trim() : '';
  return {
    icao24: icao24.trim().toLowerCase(),
    callsign: name.length > 0 ? name : null,
    originCountry: typeof country === 'string' && country.length > 0 ? country : 'Unknown',
    timePosition,
    lastContact: isFiniteNumber(lastContact) ? Math.max(lastContact, timePosition) : timePosition,
    lat,
    lon,
    altitude,
    velocity: isFiniteNumber(velocity) && velocity >= 0 ? velocity : null,
    heading: isFiniteNumber(track) ? ((track % 360) + 360) % 360 : null,
    verticalRate: isFiniteNumber(verticalRate) ? verticalRate : null,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
