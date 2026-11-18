import { EARTH_RADIUS_M } from '@flight/shared';

/** Altitudes are exaggerated so cruising aircraft visibly float above the surface. */
export const ALTITUDE_EXAGGERATION = 6;
/** Minimum lift above the globe so routes and aircraft never z-fight with the surface. */
export const SURFACE_LIFT = 0.0025;
/** Shader sentinel for unknown altitude. */
export const NO_ALTITUDE = -100_000;

export function altitudeToRadius(altitude: number | null): number {
  const a = altitude === null || !Number.isFinite(altitude) ? 0 : Math.max(0, altitude);
  return 1 + SURFACE_LIFT + (a / EARTH_RADIUS_M) * ALTITUDE_EXAGGERATION;
}
