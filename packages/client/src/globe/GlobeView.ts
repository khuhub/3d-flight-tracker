import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { unitVector } from '@flight/shared';
import type { FlightStore } from '../data/flightStore';
import { AircraftLayer } from './aircraftLayer';
import { createEarth } from './earth';
import { RouteLayer } from './routeLayer';

const PICK_RADIUS_PX = 14;
const FRAME_SAMPLES = 600;
const AUTO_ROTATE_RESUME_MS = 8000;

export interface FrameStats {
  /** Wall-clock intervals between rendered frames (ms). */
  intervals: number[];
  /** Main-thread time spent updating and submitting each frame (ms). */
  cpu: number[];
}

/** Imperative Three.js scene: globe, instanced aircraft, batched routes, picking. */
export class GlobeView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly aircraft: AircraftLayer;
  readonly routes = new RouteLayer();
  private readonly earth: ReturnType<typeof createEarth>;
  private readonly timer = new THREE.Timer();
  private readonly resizeObserver: ResizeObserver;
  private raf = 0;
  private selectedId: string | null = null;
  private renderedTracks: FlightStore['tracks'] = [];
  private pointerStart: { x: number; y: number; t: number } | null = null;
  private lastFrameAt = 0;
  private intervals = new Float32Array(FRAME_SAMPLES);
  private cpu = new Float32Array(FRAME_SAMPLES);
  private sampleCount = 0;
  drawCalls = 0;
  autoRotate = true;
  private interacting = false;
  private lastInteractionAt = -Infinity;
  private readonly viewProjection = new THREE.Matrix4();

  constructor(
    private readonly container: HTMLElement,
    private readonly store: FlightStore,
    private readonly onSelect: (icao24: string | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.dataset.testid = 'globe-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    this.camera.position.copy(new THREE.Vector3(...unitVector(30, -30)).multiplyScalar(3.1));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.06;
    this.controls.maxDistance = 8;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => {
      this.interacting = true;
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      this.lastInteractionAt = performance.now();
    });

    this.earth = createEarth(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.earth.group);
    this.aircraft = new AircraftLayer(this.scene);
    this.scene.add(this.routes.group);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.handlePointerDown);
    el.addEventListener('pointerup', this.handlePointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setSelected(icao24: string | null): void {
    this.selectedId = icao24;
  }

  /** Points the camera at a location from the given distance (globe radii from the centre). */
  lookAt(lat: number, lon: number, distance = this.camera.position.length()): void {
    this.camera.position.copy(new THREE.Vector3(...unitVector(lat, lon)).multiplyScalar(distance));
    this.controls.update();
  }

  frameStats(): FrameStats {
    const n = Math.min(this.sampleCount, FRAME_SAMPLES);
    return { intervals: Array.from(this.intervals.subarray(0, n)), cpu: Array.from(this.cpu.subarray(0, n)) };
  }

  resetFrameStats(): void {
    this.sampleCount = 0;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    const start = performance.now();
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.1);
    const distance = this.camera.position.length();
    const selectedId = this.selectedId && this.store.get(this.selectedId) ? this.selectedId : null;
    // Slow spin pauses while the user drags, has just interacted, or is inspecting an aircraft.
    this.controls.autoRotate =
      this.autoRotate && !this.interacting && selectedId === null && start - this.lastInteractionAt > AUTO_ROTATE_RESUME_MS;
    this.controls.rotateSpeed = Math.min(1, Math.max(0.04, (distance - 1) * 0.35));
    this.controls.update(delta);

    const now = this.store.now();
    const { tracks } = this.store;
    this.aircraft.update(tracks, now, distance, selectedId);
    this.routes.update({
      tracks,
      routes: this.store.routes,
      key: `${this.store.version}:${this.store.routesVersion}`,
      aircraftPositions: this.aircraft.positions,
      aircraftCount: this.aircraft.count,
      selectedId,
    });
    this.renderer.render(this.scene, this.camera);
    this.renderedTracks = tracks;
    this.drawCalls = this.renderer.info.render.calls;

    const end = performance.now();
    const slot = this.sampleCount % FRAME_SAMPLES;
    this.cpu[slot] = end - start;
    this.intervals[slot] = this.lastFrameAt === 0 ? 0 : start - this.lastFrameAt;
    this.lastFrameAt = start;
    this.sampleCount++;
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.pointerStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 || performance.now() - start.t > 600) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    this.onSelect(hit);
  };

  /** Screen position (CSS px, canvas-relative) of an aircraft, or null when hidden behind the globe. */
  screenPosition(index: number): { x: number; y: number } | null {
    if (index < 0 || index >= this.aircraft.count) return null;
    this.updateViewProjection();
    return this.project(index);
  }

  private updateViewProjection(): void {
    this.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
  }

  private project(i: number): { x: number; y: number } | null {
    const p = this.aircraft.positions;
    const px = p[i * 3]!;
    const py = p[i * 3 + 1]!;
    const pz = p[i * 3 + 2]!;
    const c = this.camera.position;
    // Hidden if the segment camera->aircraft enters the unit sphere first.
    const dx = px - c.x;
    const dy = py - c.y;
    const dz = pz - c.z;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (c.x * dx + c.y * dy + c.z * dz);
    const cc = c.x * c.x + c.y * c.y + c.z * c.z - 1;
    const disc = b * b - 4 * a * cc;
    if (disc > 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && t < 1) return null;
    }
    const e = this.viewProjection.elements;
    const w = e[3]! * px + e[7]! * py + e[11]! * pz + e[15]!;
    if (w <= 0) return null;
    const nx = (e[0]! * px + e[4]! * py + e[8]! * pz + e[12]!) / w;
    const ny = (e[1]! * px + e[5]! * py + e[9]! * pz + e[13]!) / w;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
    const { clientWidth: width, clientHeight: height } = this.renderer.domElement;
    return { x: ((nx + 1) / 2) * width, y: ((1 - ny) / 2) * height };
  }

  /** Nearest visible aircraft within the pick radius of a canvas-relative point. */
  pick(x: number, y: number): string | null {
    this.updateViewProjection();
    const fleetChanged = this.renderedTracks !== this.store.tracks;
    let best = -1;
    let bestD = PICK_RADIUS_PX * PICK_RADIUS_PX;
    for (let i = 0; i < this.aircraft.count; i++) {
      if (fleetChanged && !this.store.get(this.renderedTracks[i]!.aircraft.icao24)) continue;
      const s = this.project(i);
      if (!s) continue;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? (this.renderedTracks[best]?.aircraft.icao24 ?? null) : null;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.handlePointerDown);
    el.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.timer.dispose();
    this.aircraft.dispose();
    this.routes.dispose();
    this.earth.dispose();
    this.renderer.dispose();
    el.remove();
  }
}
