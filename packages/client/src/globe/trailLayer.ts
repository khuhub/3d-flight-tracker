import * as THREE from 'three';
import { createEstimate, estimateTrack, unitVector, type MotionTrack, type Vec3 } from '@flight/shared';
import { FLEET_TRAIL_S, SELECTED_TRAIL_S, type TrailHistory } from '../data/trailHistory';
import { altitudeToRadius } from './coords';

const REBUILD_S = 5;
const SEGMENT_S = 20;
const MAX_FLEET_SEGMENTS = 12;
const MAX_SELECTED_SEGMENTS = 64;
const STRIDE = 6; // xyz, time relative to build, live aircraft index (or -1), selected

function createMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uPositions: { value: null },
      uClock: { value: 0 },
      uFleetColor: { value: new THREE.Color(0x67dfbf) },
      uSelectedColor: { value: new THREE.Color(0x8bffe1) },
    },
    vertexShader: /* glsl */ `
      uniform highp sampler2D uPositions;
      uniform float uClock;
      attribute vec3 aTrail;
      varying float vAge;
      varying float vSelected;
      void main() {
        vec3 p = position;
        vAge = uClock - aTrail.x;
        vSelected = aTrail.z;
        if (aTrail.y >= 0.0) {
          int i = int(aTrail.y);
          int width = textureSize(uPositions, 0).x;
          p = texelFetch(uPositions, ivec2(i % width, i / width), 0).xyz;
          vAge = 0.0;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uFleetColor;
      uniform vec3 uSelectedColor;
      varying float vAge;
      varying float vSelected;
      void main() {
        float duration = mix(${FLEET_TRAIL_S}.0, ${SELECTED_TRAIL_S}.0, vSelected);
        float fade = 1.0 - smoothstep(0.0, duration, vAge);
        if (vAge < 0.0 || fade <= 0.0) discard;
        gl_FragColor = vec4(mix(uFleetColor, uSelectedColor, vSelected), fade * mix(0.44, 0.95, vSelected));
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Trail bodies are rebuilt into one line batch at a bounded cadence. One vertex per
 * moving trail reads the same position texture as routes so its tip follows the
 * animated aircraft every frame, without a second texture upload or instance mesh.
 */
export class TrailLayer {
  private readonly material = createMaterial();
  readonly lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
  private buffer: THREE.InterleavedBuffer | null = null;
  private vertices: Float32Array<ArrayBuffer> = new Float32Array(0);
  private vertexCount = 0;
  private history: TrailHistory | null = null;
  private builtVersion = -1;
  private builtKey = '';
  private builtAt = -Infinity;
  private lastNow = -Infinity;
  private selection: string | null = null;
  private fleet = false;
  selectedSegments = 0;
  fleetSegments = 0;

  constructor() {
    this.lines.name = 'aircraft-trails';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    this.lines.visible = false;
  }

  gpuBytes(): number {
    return this.vertices.byteLength;
  }

  update(input: {
    history: TrailHistory;
    tracks: readonly MotionTrack[];
    /** Changes whenever the displayed flight order changes. */
    key: string;
    now: number;
    selectedId: string | null;
    fleet: boolean;
    positions: THREE.DataTexture;
  }): void {
    const { history, key, now, selectedId, fleet, positions } = input;
    if (history !== this.history || history.version !== this.builtVersion || key !== this.builtKey ||
      selectedId !== this.selection || fleet !== this.fleet || now < this.lastNow || now - this.builtAt >= REBUILD_S) {
      this.rebuild(input.tracks, history, now, selectedId, fleet);
      this.history = history;
      this.builtVersion = history.version;
      this.builtKey = key;
      this.builtAt = now;
      this.selection = selectedId;
      this.fleet = fleet;
    }
    this.lastNow = now;
    if (this.lines.visible) {
      this.material.uniforms.uPositions!.value = positions;
      this.material.uniforms.uClock!.value = now - this.builtAt;
    }
  }

  private rebuild(
    tracks: readonly MotionTrack[],
    history: TrailHistory,
    now: number,
    selectedId: string | null,
    fleet: boolean,
  ): void {
    this.vertexCount = this.selectedSegments = this.fleetSegments = 0;
    const first = fleet ? 0 : selectedId === null ? -1 : tracks.findIndex((track) => track.aircraft.icao24 === selectedId);
    const end = fleet ? tracks.length : first + 1;
    if (first >= 0 && first < end) {
      const estimate = createEstimate();
      const previous: Vec3 = [0, 0, 0];
      const sampled: Vec3 = [0, 0, 0];
      const motion = { ...tracks[first]! };
      let i = first;
      let selected = false;
      let remaining = 0;
      const sample = (time: number, out: Vec3) => {
        estimateTrack(motion, time, estimate);
        const radius = altitudeToRadius(estimate.altitude);
        unitVector(estimate.lat, estimate.lon, out);
        out[0] *= radius;
        out[1] *= radius;
        out[2] *= radius;
      };
      const writeSection = (track: MotionTrack, start: number, finish: number, current: boolean) => {
        // Visit from newest to oldest, keeping the latest segments when capped. The
        // estimator may clear correctionFrom, so reset it before each earlier point.
        motion.aircraft = track.aircraft;
        motion.appliedAt = track.appliedAt;
        motion.correctionFrom = track.correctionFrom;
        sample(finish, previous);
        if (current) {
          this.vertex(previous, finish - now, -1, selected);
          this.vertex(previous, 0, i, selected);
        }
        for (let t = finish; t > start && remaining > 0;) {
          const next = Math.max(start, t - SEGMENT_S);
          motion.correctionFrom = track.correctionFrom;
          sample(next, sampled);
          if (sampled[0] !== previous[0] || sampled[1] !== previous[1] || sampled[2] !== previous[2]) {
            this.vertex(sampled, next - now, -1, selected);
            this.vertex(previous, t - now, -1, selected);
            remaining--;
          }
          previous[0] = sampled[0];
          previous[1] = sampled[1];
          previous[2] = sampled[2];
          t = next;
        }
        return remaining > 0;
      };
      for (; i < end; i++) {
        const id = tracks[i]!.aircraft.icao24;
        selected = id === selectedId;
        remaining = selected ? MAX_SELECTED_SEGMENTS : MAX_FLEET_SEGMENTS;
        const before = this.vertexCount;
        history.visit(id, now, selected ? SELECTED_TRAIL_S : FLEET_TRAIL_S, writeSection);
        if (selected) this.selectedSegments = (this.vertexCount - before) / 2;
        else this.fleetSegments += (this.vertexCount - before) / 2;
      }
    }
    if (this.buffer && this.vertexCount > 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, this.vertexCount * STRIDE);
      this.buffer.needsUpdate = true;
    }
    this.lines.geometry.setDrawRange(0, this.vertexCount);
    this.lines.visible = this.vertexCount > 0;
  }

  private vertex(point: Vec3, time: number, index: number, selected: boolean): void {
    const offset = this.vertexCount++ * STRIDE;
    if (offset === this.vertices.length) {
      const vertices = new Float32Array(Math.max(this.vertices.length * 2, 128 * STRIDE));
      vertices.set(this.vertices);
      this.vertices = vertices;
      this.buffer = new THREE.InterleavedBuffer(vertices, STRIDE).setUsage(THREE.DynamicDrawUsage);
      this.lines.geometry.dispose();
      this.lines.geometry = new THREE.BufferGeometry()
        .setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0))
        .setAttribute('aTrail', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    }
    this.vertices[offset] = point[0];
    this.vertices[offset + 1] = point[1];
    this.vertices[offset + 2] = point[2];
    this.vertices[offset + 3] = time;
    this.vertices[offset + 4] = index;
    this.vertices[offset + 5] = selected ? 1 : 0;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
