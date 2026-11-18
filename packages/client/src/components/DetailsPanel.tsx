import type { Aircraft, FlightRoute, RouteAirport } from '@flight/shared';

interface Props {
  aircraft: Aircraft;
  now: number;
  route: FlightRoute | undefined;
  onClose: () => void;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const airportLabel = (a: RouteAirport): string => `${a.iata ?? a.icao} · ${a.name}`;

export function DetailsPanel({ aircraft: a, now, route, onClose }: Props) {
  const ageS = Math.max(0, Math.round(now - a.timePosition));
  const airports = route?.airports;
  return (
    <aside className="details" aria-label="Aircraft details" data-testid="details-panel">
      <div className="details-head">
        <h2 data-testid="details-callsign">{a.callsign ?? 'No callsign'}</h2>
        <button type="button" className="close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <dl>
        <dt>From</dt>
        <dd data-testid="details-origin">{airports ? airportLabel(airports[0]!) : 'Unknown'}</dd>
        {airports && airports.length > 2 && (
          <>
            <dt>Via</dt>
            <dd data-testid="details-via">{airports.slice(1, -1).map((x) => x.iata ?? x.icao).join(' → ')}</dd>
          </>
        )}
        <dt>To</dt>
        <dd data-testid="details-destination">{airports ? airportLabel(airports.at(-1)!) : 'Unknown'}</dd>
        <dt>Registered in</dt>
        <dd data-testid="details-country">{a.originCountry}</dd>
        <dt>Altitude</dt>
        <dd data-testid="details-altitude">
          {a.altitude === null
            ? 'Unknown'
            : `${Math.round(a.altitude * 3.28084).toLocaleString()} ft (${Math.round(a.altitude).toLocaleString()} m)`}
        </dd>
        <dt>Speed</dt>
        <dd data-testid="details-speed">
          {a.velocity === null ? 'Unknown' : `${Math.round(a.velocity * 1.943844)} kt (${Math.round(a.velocity * 3.6)} km/h)`}
        </dd>
        <dt>Heading</dt>
        <dd data-testid="details-heading">
          {a.heading === null ? 'Unknown' : `${Math.round(a.heading)}° ${CARDINALS[Math.round(a.heading / 45) % 8]}`}
        </dd>
        <dt>Vertical rate</dt>
        <dd>{a.verticalRate === null ? 'Unknown' : `${Math.round(a.verticalRate * 196.85)} ft/min`}</dd>
        <dt>ICAO 24-bit</dt>
        <dd>{a.icao24}</dd>
        <dt>Last position</dt>
        <dd>
          {ageS} s ago{ageS > 0 ? ', shown position is estimated' : ''}
        </dd>
      </dl>
      <p className="note" data-testid="details-route-note">
        {airports
          ? 'Scheduled route for this callsign; the actual path flown may differ.'
          : 'No scheduled route is known for this callsign that fits its position.'}
      </p>
    </aside>
  );
}
