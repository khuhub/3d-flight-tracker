export const EARTH_RADIUS_M = 6_371_008.8;

const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export type Vec3 = [number, number, number];

export function normalizeLon(lon: number): number {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 && lon > 0 ? 180 : l;
}

/** Great-circle distance in metres. */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Point reached travelling `distanceM` along a great circle with the given initial bearing. */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceM: number,
  out: LatLon = { lat: 0, lon: 0 },
): LatLon {
  const d = distanceM / EARTH_RADIUS_M;
  const b = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const sinP1 = Math.sin(p1);
  const cosP1 = Math.cos(p1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);
  const sinP2 = sinP1 * cosD + cosP1 * sinD * Math.cos(b);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const l2 = l1 + Math.atan2(Math.sin(b) * sinD * cosP1, cosD - sinP1 * sinP2);
  out.lat = p2 / DEG;
  out.lon = normalizeLon(l2 / DEG);
  return out;
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from north. */
export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Unit vector in scene coordinates (Y up). Matches the UV layout of three.js
 * SphereGeometry with an equirectangular texture: lon 0 on +X, lon 90E on -Z.
 */
export function unitVector(lat: number, lon: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const p = lat * DEG;
  const l = lon * DEG;
  const c = Math.cos(p);
  out[0] = c * Math.cos(l);
  out[1] = Math.sin(p);
  out[2] = -c * Math.sin(l);
  return out;
}

export function vectorToLatLon(x: number, y: number, z: number, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  const len = Math.hypot(x, y, z) || 1;
  out.lat = Math.asin(Math.max(-1, Math.min(1, y / len))) / DEG;
  out.lon = Math.atan2(-z, x) / DEG;
  return out;
}

/** Spherical interpolation between two positions along the shorter great circle. */
export function slerpLatLon(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  f: number,
  out: LatLon = { lat: 0, lon: 0 },
): LatLon {
  const a = unitVector(lat1, lon1);
  const b = unitVector(lat2, lon2);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) {
    out.lat = lat1 + (lat2 - lat1) * f;
    out.lon = lon1;
    return out;
  }
  const s = Math.sin(omega);
  const wa = Math.sin((1 - f) * omega) / s;
  const wb = Math.sin(f * omega) / s;
  return vectorToLatLon(a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, out);
}

/** Interpolates headings along the shorter turn direction. */
export function lerpHeading(a: number, b: number, f: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + delta * f) % 360) + 360) % 360;
}
