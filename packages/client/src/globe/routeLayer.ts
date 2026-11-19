import * as THREE from 'three';
import { haversineDistance, unitVector, type FlightRoute, type MotionTrack, type Vec3 } from '@flight/shared';
import { altitudeToRadius } from './coords';

export interface DisplayRoute {
  codes: string;
  route: FlightRoute;
}

const GROUND_RADIUS = altitudeToRadius(0);
const CRUISE_RADIUS = altitudeToRadius(10_000);
/** Great-circle angle over which a line climbs from an airport to the aircraft or cruise height (~250 km). */
const CLIMB_ANGLE = 250_000 / 6_371_008.8;
/** Roughly one segment per 100 km, at least 8 per leg. */
const RADIANS_PER_SEGMENT = 100_000 / 6_371_008.8;
/** Aircraft positions texture width; height grows with the fleet. */
const TEXTURE_WIDTH = 1024;

function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

function legSteps(a: Vec3, b: Vec3): number {
  return Math.max(8, Math.ceil(angleBetween(a, b) / RADIANS_PER_SEGMENT));
}

/** Index of the leg the aircraft is currently flying: the one it deviates from least. */
export function currentLeg(route: FlightRoute, lat: number, lon: number): number {
  let best = 0;
  let bestDetour = Infinity;
  for (let i = 1; i < route.airports.length; i++) {
    const a = route.airports[i - 1]!;
    const b = route.airports[i]!;
    const detour =
      haversineDistance(a.lat, a.lon, lat, lon) + haversineDistance(lat, lon, b.lat, b.lon) - haversineDistance(a.lat, a.lon, b.lat, b.lon);
    if (detour < bestDetour) {
      bestDetour = detour;
      best = i - 1;
    }
  }
  return best;
}

/**
 * Line vertices for a set of routes. Every route is drawn departure → aircraft → arrival:
 * legs already flown or still ahead between stops are airport-to-airport arcs, and the
 * current leg is split at the aircraft. Vertices on the split leg reference the aircraft
 * by index; the shader reads its animated position each frame, so the line stays
 * attached to the moving plane without rebuilding geometry.
 *
 * Per vertex: `position` = airport unit vector (start), `aB` = other airport (end, unused
 * when attached to the aircraft), `aF` = fraction from start to end, `aIndex` = aircraft
 * index or -1.
 */
export interface RouteVertices {
  start: Float32Array;
  end: Float32Array;
  fraction: Float32Array;
  index: Float32Array;
  vertexCount: number;
}

export function buildRouteVertices(
  tracks: readonly MotionTrack[],
  routes: ReadonlyMap<string, DisplayRoute>,
  only: string | null = null,
): RouteVertices {
  interface Leg {
    a: Vec3;
    b: Vec3;
    steps: number;
    index: number;
  }
  const legs: Leg[] = [];
  let segments = 0;
  for (let i = 0; i < tracks.length; i++) {
    const a = tracks[i]!.aircraft;
    if (only !== null && a.icao24 !== only) continue;
    const r = routes.get(a.icao24);
    if (!r) continue;
    const ends = r.route.airports.map((x) => unitVector(x.lat, x.lon));
    const k = currentLeg(r.route, a.lat, a.lon);
    for (let leg = 0; leg + 1 < ends.length; leg++) {
      const steps = legSteps(ends[leg]!, ends[leg + 1]!);
      if (leg === k) {
        // Split at the aircraft. Both halves are measured from their airport. Segment
        // counts depend only on the airports, so they do not change as the plane moves.
        legs.push({ a: ends[leg]!, b: ends[leg + 1]!, steps, index: i });
        legs.push({ a: ends[leg + 1]!, b: ends[leg]!, steps, index: i });
        segments += 2 * steps;
      } else {
        legs.push({ a: ends[leg]!, b: ends[leg + 1]!, steps, index: -1 });
        segments += steps;
      }
    }
  }
  const n = segments * 2;
  const out: RouteVertices = {
    start: new Float32Array(n * 3),
    end: new Float32Array(n * 3),
    fraction: new Float32Array(n),
    index: new Float32Array(n),
    vertexCount: n,
  };
  let v = 0;
  for (const leg of legs) {
    for (let s = 0; s < leg.steps; s++) {
      for (const f of [s / leg.steps, (s + 1) / leg.steps]) {
        out.start.set(leg.a, v * 3);
        out.end.set(leg.b, v * 3);
        out.fraction[v] = f;
        out.index[v] = leg.index;
        v++;
      }
    }
  }
  return out;
}

/**
 * CPU version of the vertex shader below (kept in sync; used by tests). `aircraft` is
 * the aircraft's world position for vertices attached to it.
 */
export function routeVertexPosition(start: Vec3, end: Vec3, f: number, aircraft: Vec3 | null): Vec3 {
  const pr = aircraft ? Math.hypot(...aircraft) : CRUISE_RADIUS;
  const b: Vec3 = aircraft ? [aircraft[0] / pr, aircraft[1] / pr, aircraft[2] / pr] : end;
  const omega = angleBetween(start, b);
  const s = Math.sin(omega);
  const wa = s < 1e-6 ? 1 - f : Math.sin((1 - f) * omega) / s;
  const wb = s < 1e-6 ? f : Math.sin(f * omega) / s;
  let x = start[0] * wa + b[0] * wb;
  let y = start[1] * wa + b[1] * wb;
  let z = start[2] * wa + b[2] * wb;
  const len = Math.hypot(x, y, z) || 1;
  let climb: number;
  if (aircraft) climb = Math.min(1, (f * omega) / Math.max(1e-6, Math.min(CLIMB_ANGLE, omega)));
  else climb = Math.min(1, (Math.min(f, 1 - f) * omega) / Math.max(1e-6, Math.min(CLIMB_ANGLE, omega / 2)));
  const r = GROUND_RADIUS + (pr - GROUND_RADIUS) * Math.sin((climb * Math.PI) / 2);
  x *= r / len;
  y *= r / len;
  z *= r / len;
  return [x, y, z];
}

function routeMaterial(positions: THREE.DataTexture, color: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uPositions: { value: positions },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uGround: { value: GROUND_RADIUS },
      uCruise: { value: CRUISE_RADIUS },
      uClimb: { value: CLIMB_ANGLE },
    },
    vertexShader: /* glsl */ `
      precision highp float;
      uniform highp sampler2D uPositions;
      uniform float uGround;
      uniform float uCruise;
      uniform float uClimb;
      attribute vec3 aB;
      attribute float aF;
      attribute float aIndex;
      void main() {
        vec3 a = position;
        vec3 b = aB;
        float pr = uCruise;
        bool attached = aIndex >= 0.0;
        if (attached) {
          int i = int(aIndex + 0.5);
          vec3 p = texelFetch(uPositions, ivec2(i % ${TEXTURE_WIDTH}, i / ${TEXTURE_WIDTH}), 0).xyz;
          pr = length(p);
          b = p / max(pr, 1e-6);
        }
        float omega = acos(clamp(dot(a, b), -1.0, 1.0));
        float s = sin(omega);
        float wa = s < 1e-6 ? 1.0 - aF : sin((1.0 - aF) * omega) / s;
        float wb = s < 1e-6 ? aF : sin(aF * omega) / s;
        vec3 d = normalize(a * wa + b * wb);
        float climb = attached
          ? min(1.0, aF * omega / max(1e-6, min(uClimb, omega)))
          : min(1.0, min(aF, 1.0 - aF) * omega / max(1e-6, min(uClimb, omega * 0.5)));
        float r = uGround + (pr - uGround) * sin(climb * 1.5707963);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(d * r, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }`,
  });
}

/**
 * Every known route in one draw call, plus the selected flight's route and its airports
 * emphasised. Geometry is rebuilt when a snapshot changes the fleet; between snapshots
 * only the small aircraft-position texture is uploaded each frame.
 */
export class RouteLayer {
  readonly group = new THREE.Group();
  private texture: THREE.DataTexture;
  private texels = new Float32Array(0);
  private readonly material: THREE.ShaderMaterial;
  private readonly selectedMaterial: THREE.ShaderMaterial;
  private readonly airportMaterial = new THREE.PointsMaterial({ color: 0xffd36b, size: 7, sizeAttenuation: false, depthWrite: false });
  private readonly lines: THREE.LineSegments;
  private readonly selected: THREE.LineSegments;
  private readonly airports = new THREE.Points(new THREE.BufferGeometry(), this.airportMaterial);
  private builtKey = '';
  private selectedKey = '';
  lastRebuildMs = 0;
  routeCount = 0;

  constructor() {
    this.texture = this.createTexture(16_384);
    this.material = routeMaterial(this.texture, 0x7fbfff, 0.22);
    this.selectedMaterial = routeMaterial(this.texture, 0xffffff, 1);
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.selected = new THREE.LineSegments(new THREE.BufferGeometry(), this.selectedMaterial);
    this.group.name = 'airport-routes';
    for (const o of [this.lines, this.selected, this.airports]) o.frustumCulled = false;
    this.selected.renderOrder = 2;
    this.airports.renderOrder = 3;
    this.group.add(this.lines, this.selected, this.airports);
  }

  private createTexture(capacity: number): THREE.DataTexture {
    const height = Math.ceil(capacity / TEXTURE_WIDTH);
    this.texels = new Float32Array(TEXTURE_WIDTH * height * 4);
    const t = new THREE.DataTexture(this.texels, TEXTURE_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  get segments(): number {
    return (this.lines.geometry.getAttribute('position')?.count ?? 0) / 2;
  }

  get selectedSegments(): number {
    return (this.selected.geometry.getAttribute('position')?.count ?? 0) / 2;
  }

  get positionsTexture(): THREE.DataTexture {
    return this.texture;
  }

  gpuBytes(): number {
    let bytes = this.texels.byteLength;
    for (const o of [this.lines, this.selected]) {
      for (const name of ['position', 'aB', 'aF', 'aIndex']) bytes += o.geometry.getAttribute(name)?.array.byteLength ?? 0;
    }
    return bytes;
  }

  update(input: {
    tracks: readonly MotionTrack[];
    routes: ReadonlyMap<string, DisplayRoute>;
    /** Changes whenever the fleet or its routes change. */
    key: string;
    aircraftPositions: Float32Array;
    aircraftCount: number;
    selectedId: string | null;
  }): void {
    const { tracks, routes, key, aircraftPositions: p, aircraftCount: n, selectedId } = input;
    if (n * 4 > this.texels.length) {
      this.texture.dispose();
      let cap = this.texels.length / 4;
      while (cap < n) cap *= 2;
      this.texture = this.createTexture(cap);
      this.material.uniforms.uPositions!.value = this.texture;
      this.selectedMaterial.uniforms.uPositions!.value = this.texture;
    }
    const t = this.texels;
    for (let i = 0; i < n; i++) {
      t[i * 4] = p[i * 3]!;
      t[i * 4 + 1] = p[i * 3 + 1]!;
      t[i * 4 + 2] = p[i * 3 + 2]!;
    }
    this.texture.needsUpdate = true;

    if (key !== this.builtKey) {
      const start = performance.now();
      upload(this.lines, buildRouteVertices(tracks, routes));
      let count = 0;
      for (const track of tracks) if (routes.has(track.aircraft.icao24)) count++;
      this.routeCount = count;
      this.builtKey = key;
      this.selectedKey = '\0';
      this.lastRebuildMs = performance.now() - start;
    }
    const sel = selectedId ?? '';
    if (sel !== this.selectedKey) {
      const r = selectedId ? routes.get(selectedId) : undefined;
      upload(this.selected, buildRouteVertices(r ? tracks : [], routes, selectedId));
      const points = new Float32Array((r?.route.airports.length ?? 0) * 3);
      r?.route.airports.forEach((a, i) => {
        const u = unitVector(a.lat, a.lon);
        points.set([u[0] * GROUND_RADIUS, u[1] * GROUND_RADIUS, u[2] * GROUND_RADIUS], i * 3);
      });
      this.airports.geometry.dispose();
      this.airports.geometry = new THREE.BufferGeometry();
      this.airports.geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
      this.selectedKey = sel;
    }
    this.material.uniforms.uOpacity!.value = selectedId ? 0.08 : 0.22;
  }

  dispose(): void {
    for (const o of [this.lines, this.selected, this.airports]) o.geometry.dispose();
    this.material.dispose();
    this.selectedMaterial.dispose();
    this.airportMaterial.dispose();
    this.texture.dispose();
  }
}

function upload(lines: THREE.LineSegments, v: RouteVertices): void {
  lines.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v.start, 3));
  g.setAttribute('aB', new THREE.BufferAttribute(v.end, 3));
  g.setAttribute('aF', new THREE.BufferAttribute(v.fraction, 1));
  g.setAttribute('aIndex', new THREE.BufferAttribute(v.index, 1));
  lines.geometry = g;
}
