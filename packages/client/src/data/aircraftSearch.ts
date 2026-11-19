import type { MotionTrack } from '@flight/shared';

const RESULT_LIMIT = 8;

export interface SearchAircraft {
  icao24: string;
  callsign: string | null;
}

interface SearchEntry extends SearchAircraft {
  address: string;
  name: string;
}

export function indexAircraft(tracks: readonly MotionTrack[]): SearchEntry[] {
  return tracks.map(({ aircraft: { icao24, callsign } }) => ({
    icao24,
    callsign,
    address: icao24.toUpperCase(),
    name: callsign?.trim().toUpperCase() ?? '',
  }));
}

export function searchAircraft(index: readonly SearchEntry[], query: string): SearchAircraft[] {
  const term = query.trim().toUpperCase();
  if (!term) return [];
  const exact: SearchAircraft[] = [];
  const prefixes: SearchAircraft[] = [];
  const partial: SearchAircraft[] = [];
  for (const entry of index) {
    const { address, name } = entry;
    if (address === term || name === term) {
      exact.push(entry);
      if (exact.length === RESULT_LIMIT) return exact;
    } else if (address.startsWith(term) || name.startsWith(term)) {
      if (prefixes.length < RESULT_LIMIT) prefixes.push(entry);
    } else if ((address.includes(term) || name.includes(term)) && partial.length < RESULT_LIMIT) {
      partial.push(entry);
    }
  }
  return [...exact, ...prefixes, ...partial].slice(0, RESULT_LIMIT);
}
