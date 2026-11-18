import * as THREE from 'three';
import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import countriesTopo from 'world-atlas/countries-110m.json';

const TEXTURE_WIDTH = 4096;
const TEXTURE_HEIGHT = 2048;

const PALETTE = {
  ocean: '#08121c',
  land: '#16273a',
  coast: '#3f6584',
  border: 'rgba(110, 150, 185, 0.28)',
  graticule: 'rgba(80, 120, 160, 0.13)',
  equator: 'rgba(110, 160, 200, 0.22)',
};

type Topo = Topology<{ countries: GeometryCollection; land: GeometryCollection }>;

/** Builds the dark atlas texture from bundled Natural Earth data (no network access). */
export function createAtlasTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const x = (lon: number): number => ((lon + 180) / 360) * TEXTURE_WIDTH;
  const y = (lat: number): number => ((90 - lat) / 180) * TEXTURE_HEIGHT;

  ctx.fillStyle = PALETTE.ocean;
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  ctx.lineWidth = 1.2;
  for (let lon = -180; lon <= 180; lon += 15) {
    ctx.strokeStyle = PALETTE.graticule;
    ctx.beginPath();
    ctx.moveTo(x(lon), 0);
    ctx.lineTo(x(lon), TEXTURE_HEIGHT);
    ctx.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    ctx.strokeStyle = lat === 0 ? PALETTE.equator : PALETTE.graticule;
    ctx.beginPath();
    ctx.moveTo(0, y(lat));
    ctx.lineTo(TEXTURE_WIDTH, y(lat));
    ctx.stroke();
  }

  const topo = countriesTopo as unknown as Topo;
  const land = feature(topo, topo.objects.land);
  const polygons: Position[][][] = [];
  const features: Feature[] = 'features' in land ? land.features : [land as Feature];
  for (const f of features) {
    const g = f.geometry as Polygon | MultiPolygon;
    if (g.type === 'Polygon') polygons.push(g.coordinates);
    else polygons.push(...g.coordinates);
  }

  const traceRing = (ring: Position[], shift: number): void => {
    // Unwrap longitudes so rings crossing the antimeridian stay continuous.
    let prev = ring[0]![0]!;
    let offset = 0;
    const first = ring[0]!;
    ctx.moveTo(x(first[0]! + shift), y(first[1]!));
    let sumLat = 0;
    for (const p of ring) {
      let lon = p[0]! + offset;
      if (lon - prev > 180) {
        offset -= 360;
        lon -= 360;
      } else if (prev - lon > 180) {
        offset += 360;
        lon += 360;
      }
      ctx.lineTo(x(lon + shift), y(p[1]!));
      prev = lon;
      sumLat += p[1]!;
    }
    if (offset !== 0) {
      // The ring encircles a pole: close it along the pole edge.
      const pole = sumLat / ring.length < 0 ? -90 : 90;
      ctx.lineTo(x(prev + shift), y(pole));
      ctx.lineTo(x(first[0]! + shift), y(pole));
    }
    ctx.closePath();
  };

  ctx.fillStyle = PALETTE.land;
  ctx.strokeStyle = PALETTE.coast;
  ctx.lineWidth = 1.6;
  for (const shift of [-360, 0, 360]) {
    ctx.beginPath();
    for (const poly of polygons) for (const ring of poly) traceRing(ring, shift);
    ctx.fill('evenodd');
    ctx.stroke();
  }

  const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b);
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const line of borders.coordinates) {
    let prev: number | null = null;
    for (const p of line) {
      const px = x(p[0]!);
      if (prev === null || Math.abs(p[0]! - prev) > 180) ctx.moveTo(px, y(p[1]!));
      else ctx.lineTo(px, y(p[1]!));
      prev = p[0]!;
    }
  }
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  return texture;
}

export function createEarth(maxAnisotropy: number): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const texture = createAtlasTexture(maxAnisotropy);
  const globeGeometry = new THREE.SphereGeometry(1, 128, 96);
  const globeMaterial = new THREE.MeshBasicMaterial({ map: texture });
  const globe = new THREE.Mesh(globeGeometry, globeMaterial);
  globe.name = 'globe';
  globe.renderOrder = 0;
  group.add(globe);

  const glowGeometry = new THREE.SphereGeometry(1.12, 64, 48);
  const glowMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float rim = 1.0 - abs(dot(vNormal, vView));
        float glow = pow(clamp(1.0 - rim, 0.0, 1.0), 3.0);
        gl_FragColor = vec4(0.25, 0.55, 0.85, 1.0) * glow * 0.55;
      }`,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.name = 'atmosphere';
  group.add(glow);

  return {
    group,
    dispose: () => {
      texture.dispose();
      globeGeometry.dispose();
      globeMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
    },
  };
}
