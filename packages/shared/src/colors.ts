/** Altitude colour ramp shared by aircraft and the legend. */
export const ALTITUDE_STOPS: ReadonlyArray<{ altitude: number; color: [number, number, number] }> = [
  { altitude: 0, color: [1.0, 0.42, 0.21] },
  { altitude: 2000, color: [1.0, 0.75, 0.2] },
  { altitude: 5000, color: [0.62, 0.93, 0.33] },
  { altitude: 8000, color: [0.2, 0.86, 0.86] },
  { altitude: 11000, color: [0.36, 0.55, 1.0] },
  { altitude: 13500, color: [0.78, 0.45, 1.0] },
];

export const UNKNOWN_ALTITUDE_COLOR: [number, number, number] = [0.75, 0.75, 0.78];

export function altitudeColor(
  altitude: number | null,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  if (altitude === null || !Number.isFinite(altitude)) return copy(UNKNOWN_ALTITUDE_COLOR, out);
  const first = ALTITUDE_STOPS[0]!;
  const last = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1]!;
  if (altitude <= first.altitude) return copy(first.color, out);
  if (altitude >= last.altitude) return copy(last.color, out);
  for (let i = 1; i < ALTITUDE_STOPS.length; i++) {
    const hi = ALTITUDE_STOPS[i]!;
    if (altitude <= hi.altitude) {
      const lo = ALTITUDE_STOPS[i - 1]!;
      const f = (altitude - lo.altitude) / (hi.altitude - lo.altitude);
      out[0] = lo.color[0] + (hi.color[0] - lo.color[0]) * f;
      out[1] = lo.color[1] + (hi.color[1] - lo.color[1]) * f;
      out[2] = lo.color[2] + (hi.color[2] - lo.color[2]) * f;
      return out;
    }
  }
  return copy(last.color, out);
}

function copy(c: readonly [number, number, number], out: [number, number, number]): [number, number, number] {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}
