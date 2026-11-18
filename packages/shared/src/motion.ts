import type { Aircraft } from './types';
import { destinationPoint, haversineDistance, lerpHeading, slerpLatLon, type LatLon } from './geo';

/**
 * Positions are extrapolated along the reported great-circle track for at most this
 * long after the position report. Past the cutoff an aircraft freezes at its last
 * estimate and is flagged stale, so a missed poll cannot fling it across an ocean.
 * Five minutes covers the default three-minute poll plus OpenSky latency.
 */
export const MAX_EXTRAPOLATION_S = 300;

/** Duration over which a visible correction is blended after a new snapshot arrives. */
export const CORRECTION_BLEND_S = 2;

/** Corrections larger than this snap instead of gliding, to avoid sweeping across the globe. */
export const CORRECTION_SNAP_M = 150_000;

export interface MotionEstimate extends LatLon {
  altitude: number | null;
  heading: number | null;
  /** True once the extrapolation cutoff has been reached. */
  stale: boolean;
}

export function createEstimate(): MotionEstimate {
  return { lat: 0, lon: 0, altitude: null, heading: null, stale: false };
}

/** Dead-reckoned position of an aircraft at unix time `t` (seconds). */
export function extrapolate(
  a: Pick<Aircraft, 'lat' | 'lon' | 'altitude' | 'velocity' | 'heading' | 'timePosition'>,
  t: number,
  out: MotionEstimate = createEstimate(),
  maxExtrapolationS = MAX_EXTRAPOLATION_S,
): MotionEstimate {
  const elapsed = t - a.timePosition;
  const dt = Math.min(Math.max(elapsed, 0), maxExtrapolationS);
  out.altitude = a.altitude;
  out.heading = a.heading;
  out.stale = elapsed > maxExtrapolationS;
  if (a.velocity === null || a.heading === null || dt === 0 || a.velocity === 0) {
    out.lat = a.lat;
    out.lon = a.lon;
    return out;
  }
  destinationPoint(a.lat, a.lon, a.heading, a.velocity * dt, out);
  return out;
}

/** A tracked aircraft: the latest observation plus a fading correction from where it was drawn before. */
export interface MotionTrack {
  aircraft: Aircraft;
  /** Unix seconds when the observation was applied. */
  appliedAt: number;
  /** Displayed position when the observation arrived, or null when no blend is needed. */
  correctionFrom: { lat: number; lon: number; altitude: number | null; heading: number | null } | null;
}

export function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/**
 * Builds the new track for an observation, blending from `previous` so the aircraft
 * glides to its corrected position instead of jumping.
 */
export function nextTrack(previous: MotionTrack | undefined, aircraft: Aircraft, now: number): MotionTrack {
  if (!previous) return { aircraft, appliedAt: now, correctionFrom: null };
  const shown = estimateTrack(previous, now);
  const target = extrapolate(aircraft, now);
  const jump = haversineDistance(shown.lat, shown.lon, target.lat, target.lon);
  if (jump > CORRECTION_SNAP_M || jump < 1) return { aircraft, appliedAt: now, correctionFrom: null };
  return {
    aircraft,
    appliedAt: now,
    correctionFrom: { lat: shown.lat, lon: shown.lon, altitude: shown.altitude, heading: shown.heading },
  };
}

/** Displayed position of a track at time `now`, including any in-progress correction blend. */
export function estimateTrack(
  track: MotionTrack,
  now: number,
  out: MotionEstimate = createEstimate(),
  maxExtrapolationS = MAX_EXTRAPOLATION_S,
): MotionEstimate {
  extrapolate(track.aircraft, now, out, maxExtrapolationS);
  const from = track.correctionFrom;
  if (!from) return out;
  const f = smoothstep((now - track.appliedAt) / CORRECTION_BLEND_S);
  if (f >= 1) {
    track.correctionFrom = null;
    return out;
  }
  slerpLatLon(from.lat, from.lon, out.lat, out.lon, f, out);
  if (from.altitude !== null && out.altitude !== null) out.altitude = from.altitude + (out.altitude - from.altitude) * f;
  if (from.heading !== null && out.heading !== null) out.heading = lerpHeading(from.heading, out.heading, f);
  return out;
}
