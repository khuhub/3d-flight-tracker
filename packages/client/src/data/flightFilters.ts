import type { Aircraft } from '@flight/shared';

export type AltitudeBand = 'all' | 'low' | 'mid' | 'high' | 'unknown';

export interface FlightFilters {
  readonly altitudeBand: AltitudeBand;
  readonly originCountry: string | null;
  readonly knownRouteOnly: boolean;
}

export const DEFAULT_FLIGHT_FILTERS: FlightFilters = {
  altitudeBand: 'all',
  originCountry: null,
  knownRouteOnly: false,
};

const METRES_PER_FOOT = 0.3048;

/** Use the reported altitude in metres, not the rounded label or the animated value. */
function altitudeBand(altitude: Aircraft['altitude']): Exclude<AltitudeBand, 'all'> {
  if (altitude === null) return 'unknown';
  if (altitude < 10_000 * METRES_PER_FOOT) return 'low';
  if (altitude < 30_000 * METRES_PER_FOOT) return 'mid';
  return 'high';
}

export function sameFilters(a: FlightFilters, b: FlightFilters): boolean {
  return a.altitudeBand === b.altitudeBand && a.originCountry === b.originCountry && a.knownRouteOnly === b.knownRouteOnly;
}

export function matchesFilters(aircraft: Aircraft, knownRoute: boolean, filters: FlightFilters): boolean {
  return (
    (filters.altitudeBand === 'all' || filters.altitudeBand === altitudeBand(aircraft.altitude)) &&
    (filters.originCountry === null || filters.originCountry === aircraft.originCountry) &&
    (!filters.knownRouteOnly || knownRoute)
  );
}
