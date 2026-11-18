import * as THREE from 'three';
import { altitudeColor, createEstimate, estimateTrack, type MotionTrack } from '@flight/shared';
import { altitudeToRadius } from './coords';

const DEG = Math.PI / 180;

/** Flat airplane silhouette, nose along +Y, wings along X, normal along +Z. */
function createAirplaneGeometry(): THREE.BufferGeometry {
  const half: Array<[number, number]> = [
    [0, 1],
    [0.09, 0.86],
    [0.11, 0.3],
    [1, -0.12],
    [1, -0.26],
    [0.11, -0.08],
    [0.08, -0.62],
    [0.42, -0.86],
    [0.42, -0.98],
    [0, -0.86],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(half[0]![0], half[0]![1]);
  for (const [x, y] of half.slice(1)) shape.lineTo(x, y);
  for (const [x, y] of half.slice(1, -1).reverse()) shape.lineTo(-x, y);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

/**
 * All aircraft share one InstancedMesh, so the whole fleet is a single draw call. The
 * instance capacity grows by doubling and is never smaller than the dataset.
 */
export class AircraftLayer {
  mesh!: THREE.InstancedMesh;
  /** World-space position of each displayed aircraft, reused by picking. */
  positions = new Float32Array(0);
  stale = new Uint8Array(0);
  count = 0;
  private readonly geometry = createAirplaneGeometry();
  private readonly material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
  private readonly estimate = createEstimate();
  private readonly color: [number, number, number] = [0, 0, 0];

  constructor(private readonly parent: THREE.Object3D) {
    this.allocate(16_384);
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  private allocate(capacity: number): void {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = 'aircraft';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 3;
    this.mesh = mesh;
    this.positions = new Float32Array(capacity * 3);
    this.stale = new Uint8Array(capacity);
    this.parent.add(mesh);
  }

  update(tracks: readonly MotionTrack[], now: number, cameraDistance: number, selectedId: string | null): void {
    const n = tracks.length;
    if (n > this.capacity) {
      let cap = this.capacity;
      while (cap < n) cap *= 2;
      this.allocate(cap);
    }
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    const pos = this.positions;
    const baseSize = Math.min(0.05, Math.max(0.0009, (cameraDistance - 1) * 0.006));
    const est = this.estimate;
    const c = this.color;

    for (let i = 0; i < n; i++) {
      const track = tracks[i]!;
      estimateTrack(track, now, est);
      const r = altitudeToRadius(est.altitude);
      const lat = est.lat * DEG;
      const lon = est.lon * DEG;
      const h = (est.heading ?? 0) * DEG;
      const sp = Math.sin(lat);
      const cp = Math.cos(lat);
      const sl = Math.sin(lon);
      const cl = Math.cos(lon);
      // Local frame: up (radial), north, east, in scene coordinates.
      const ux = cp * cl;
      const uy = sp;
      const uz = -cp * sl;
      const nx = -sp * cl;
      const ny = cp;
      const nz = sp * sl;
      const ex = -sl;
      const ez = -cl;
      const ch = Math.cos(h);
      const sh = Math.sin(h);
      const fx = nx * ch + ex * sh;
      const fy = ny * ch;
      const fz = nz * ch + ez * sh;
      const rx = ex * ch - nx * sh;
      const ry = -ny * sh;
      const rz = ez * ch - nz * sh;
      const selected = selectedId !== null && track.aircraft.icao24 === selectedId;
      const s = selected ? baseSize * 1.9 : baseSize;
      const o = i * 16;
      m[o] = rx * s;
      m[o + 1] = ry * s;
      m[o + 2] = rz * s;
      m[o + 3] = 0;
      m[o + 4] = fx * s;
      m[o + 5] = fy * s;
      m[o + 6] = fz * s;
      m[o + 7] = 0;
      m[o + 8] = ux * s;
      m[o + 9] = uy * s;
      m[o + 10] = uz * s;
      m[o + 11] = 0;
      m[o + 12] = ux * r;
      m[o + 13] = uy * r;
      m[o + 14] = uz * r;
      m[o + 15] = 1;
      pos[i * 3] = ux * r;
      pos[i * 3 + 1] = uy * r;
      pos[i * 3 + 2] = uz * r;
      this.stale[i] = est.stale ? 1 : 0;

      if (selected) {
        c[0] = 1;
        c[1] = 1;
        c[2] = 1;
      } else {
        altitudeColor(est.altitude, c);
        if (est.stale) {
          c[0] *= 0.45;
          c[1] *= 0.45;
          c[2] *= 0.45;
        }
      }
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
    this.count = n;
    this.mesh.count = n;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, n * 16);
    im.needsUpdate = true;
    const ic = this.mesh.instanceColor!;
    ic.clearUpdateRanges();
    ic.addUpdateRange(0, n * 3);
    ic.needsUpdate = true;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
