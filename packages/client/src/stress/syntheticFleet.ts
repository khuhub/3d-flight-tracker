/**
 * SYNTHETIC STRESS DATA. Generated in the browser only for performance testing
 * (`?stress=12000`). It is never written to disk, never mixed with real recordings,
 * and the UI labels it as synthetic.
 */
import { destinationPoint, type Aircraft } from '@flight/shared';
import type { DisplayRoute } from '../globe/routeLayer';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSyntheticFleet(count: number, now: number, seed = 42): Aircraft[] {
  const rng = mulberry32(seed);
  const fleet: Aircraft[] = [];
  for (let i = 0; i < count; i++) {
    const lat = Math.asin(rng() * 1.6 - 0.75) * (180 / Math.PI);
    const lon = rng() * 360 - 180;
    fleet.push({
      icao24: (0xf00000 + i).toString(16),
      callsign: `SYN${String(i).padStart(5, '0')}`,
      originCountry: 'Synthetic',
      timePosition: now,
      lastContact: now,
      lat,
      lon,
      altitude: 1000 + rng() * 11_500,
      velocity: 120 + rng() * 140,
      heading: rng() * 360,
      verticalRate: 0,
    });
  }
  return fleet;
}

/** A fictional 6,000 km route through each synthetic aircraft, for stress mode only. */
export function syntheticRoutes(fleet: Aircraft[]): Map<string, DisplayRoute> {
  const routes = new Map<string, DisplayRoute>();
  for (const a of fleet) {
    const from = destinationPoint(a.lat, a.lon, ((a.heading ?? 0) + 180) % 360, 3_000_000);
    const to = destinationPoint(a.lat, a.lon, a.heading ?? 0, 3_000_000);
    routes.set(a.icao24, {
      codes: `SYN-${a.icao24}`,
      route: {
        airports: [
          { icao: 'SYN1', iata: null, name: 'Synthetic departure', ...from },
          { icao: 'SYN2', iata: null, name: 'Synthetic arrival', ...to },
        ],
      },
    });
  }
  return routes;
}

/** Moves every synthetic aircraft forward along its track to time `now`. */
export function advanceSyntheticFleet(fleet: Aircraft[], now: number): Aircraft[] {
  const p = { lat: 0, lon: 0 };
  return fleet.map((a) => {
    destinationPoint(a.lat, a.lon, a.heading ?? 0, (a.velocity ?? 0) * (now - a.timePosition), p);
    return { ...a, lat: p.lat, lon: p.lon, timePosition: now, lastContact: now };
  });
}
