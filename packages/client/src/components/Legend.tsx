import { ALTITUDE_STOPS } from '@flight/shared';
import type { ReactNode } from 'react';

interface Props {
  routeCount: number;
  aircraftCount: number;
  children?: ReactNode;
}

const MAX_ALT = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1]!.altitude;
const gradient = `linear-gradient(to right, ${ALTITUDE_STOPS.map(
  (s) => `rgb(${s.color.map((c) => Math.round(c * 255)).join(' ')}) ${((s.altitude / MAX_ALT) * 100).toFixed(1)}%`,
).join(', ')})`;

export function Legend({ routeCount, aircraftCount, children }: Props) {
  return (
    <section className="legend" aria-label="Legend">
      <h2>Altitude</h2>
      <div className="ramp" style={{ background: gradient }} />
      <div className="ramp-labels">
        <span>0</span>
        <span>15k</span>
        <span>30k</span>
        <span>44k ft</span>
      </div>
      <ul className="route-key">
        <li>
          <svg width="34" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="33" y2="4" stroke="#7fbfff" strokeWidth="2" />
          </svg>
          Route: departure → arrival airport
        </li>
        <li>
          <svg width="34" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="27" y2="4" stroke="#ffffff" strokeWidth="2" />
            <circle cx="30" cy="4" r="3" fill="#ffd36b" />
          </svg>
          Selected flight and its airports
        </li>
      </ul>
      <p className="note" data-testid="route-coverage">
        Routes known for {routeCount.toLocaleString()} of {aircraftCount.toLocaleString()} aircraft. Scheduled
        routes by callsign; flights without one are not guessed.
      </p>
      {children}
    </section>
  );
}
