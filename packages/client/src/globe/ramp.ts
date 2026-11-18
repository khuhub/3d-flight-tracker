import { ALTITUDE_STOPS, UNKNOWN_ALTITUDE_COLOR } from '@flight/shared';
import { NO_ALTITUDE } from './coords';

const f = (n: number): string => n.toFixed(4);
const vec3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;

/** GLSL version of the shared altitude colour ramp, generated so both stay in sync. */
export function glslAltitudeRamp(): string {
  const lines = [
    'vec3 altitudeColor(float alt) {',
    `  if (alt <= ${f(NO_ALTITUDE + 1)}) return ${vec3(UNKNOWN_ALTITUDE_COLOR)};`,
    `  vec3 c = ${vec3(ALTITUDE_STOPS[0]!.color)};`,
  ];
  for (let i = 1; i < ALTITUDE_STOPS.length; i++) {
    const lo = ALTITUDE_STOPS[i - 1]!;
    const hi = ALTITUDE_STOPS[i]!;
    lines.push(
      `  c = mix(c, ${vec3(hi.color)}, clamp((alt - ${f(lo.altitude)}) / ${f(hi.altitude - lo.altitude)}, 0.0, 1.0));`,
    );
  }
  lines.push('  return c;', '}');
  return lines.join('\n');
}
