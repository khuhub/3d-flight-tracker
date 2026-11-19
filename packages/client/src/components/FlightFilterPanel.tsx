import { useMemo } from 'react';
import type { MotionTrack } from '@flight/shared';
import { DEFAULT_FLIGHT_FILTERS, sameFilters, type AltitudeBand, type FlightFilters } from '../data/flightFilters';
import './flightFilters.css';

const ALTITUDE_OPTIONS: Record<AltitudeBand, string> = {
  all: 'All altitudes',
  low: 'Below 10,000 ft',
  mid: '10,000 to below 30,000 ft',
  high: '30,000 ft and above',
  unknown: 'Unknown altitude',
};

interface Props {
  filters: FlightFilters;
  onChange: (filters: FlightFilters) => void;
  allTracks: readonly MotionTrack[];
  visibleCount: number;
}

export function FlightFilterPanel({ filters, onChange, allTracks, visibleCount }: Props) {
  const country = filters.originCountry;
  const countries = useMemo(() => {
    const names = new Set(allTracks.map((track) => track.aircraft.originCountry));
    if (country !== null) names.add(country);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [allTracks, country]);
  const active = !sameFilters(filters, DEFAULT_FLIGHT_FILTERS);

  return (
    <details className="flight-filters">
      <summary>
        Filters{active && ` (${visibleCount.toLocaleString()} of ${allTracks.length.toLocaleString()})`}
      </summary>
      <div className="flight-filter-fields">
        <label>
          Altitude band
          <select value={filters.altitudeBand} onChange={(e) => onChange({ ...filters, altitudeBand: e.target.value as AltitudeBand })}>
            {Object.entries(ALTITUDE_OPTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          Origin country (registration)
          <select value={country ?? ''} onChange={(e) => onChange({ ...filters, originCountry: e.target.value || null })}>
            <option value="">All countries</option>
            {countries.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="flight-filter-checkbox">
          <input type="checkbox" checked={filters.knownRouteOnly} onChange={(e) => onChange({ ...filters, knownRouteOnly: e.target.checked })} />
          Known routes only
        </label>
        {active && visibleCount === 0 && <p className="flight-filter-empty">No aircraft match these filters.</p>}
        <button type="button" disabled={!active} onClick={() => onChange(DEFAULT_FLIGHT_FILTERS)}>Reset filters</button>
      </div>
    </details>
  );
}
