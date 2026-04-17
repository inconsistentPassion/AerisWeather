/**
 * Globe — Earth sphere with streaming map tiles.
 *
 * Uses TileTexture engine for progressive tile loading as camera zooms.
 * Falls back to procedural Earth textures if tiles fail to load.
 */

import * as THREE from 'three';
import { createTileEngine, type TileEngine } from './TileTexture';

export const GLOBE_RADIUS = 6371;

// ── Noise primitives (fallback only) ─────────────────────────────────

function hash2D(x: number, y: number): number {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return hash2D(ix, iy) * (1 - ux) * (1 - uy) +
         hash2D(ix + 1, iy) * ux * (1 - uy) +
         hash2D(ix, iy + 1) * (1 - ux) * uy +
         hash2D(ix + 1, iy + 1) * ux * uy;
}

function fbm(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * smoothNoise(x * freq, y * freq);
    amp *= gain;
    freq *= lacunarity;
  }
  return val;
}

function ridged(x: number, y: number, octaves: number): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(smoothNoise(x * freq, y * freq) * 2 - 1);
    val += amp * n * n;
    amp *= 0.5;
    freq *= 2.1;
  }
  return val;
}

// ── Procedural fallback textures ──────────────────────────────────────

function getElevation(lon: number, lat: number): number {
  const u = (lon + Math.PI) / (2 * Math.PI);
  const v = (lat + Math.PI / 2) / Math.PI;

  let continent = fbm(u * 2.5 + 0.3, v * 1.8 + 0.7, 5, 2.0, 0.55);
  continent += fbm(u * 4.0 + 3.14, v * 3.0 + 1.57, 4, 2.2, 0.45) * 0.4;
  continent += ridged(u * 3.0 + 1.2, v * 2.5 + 2.8, 4) * 0.2;

  const threshold = 0.52;
  let elev = (continent - threshold) * 4.0;
  elev = Math.max(-1, Math.min(1, elev));

  if (elev > 0) {
    const mountains = ridged(u * 8.0 + 5.5, v * 6.0 + 3.3, 5) * 0.3;
    elev += mountains * elev;
  }

  const islands = fbm(u * 12.0 + 7.7, v * 10.0 + 4.4, 4, 2.5, 0.4);
  if (elev < -0.3 && islands > 0.72) {
    elev = (islands - 0.72) * 3.0;
  }

  return elev;
}

function getPixelColor(elev: number, lat: number): [number, number, number] {
  const absLat = Math.abs(lat);
  const latDeg = absLat * (180 / Math.PI);

  if (elev < 0) {
    const depth = Math.min(-elev, 1);
    if (depth < 0.15) return [35, 100 + depth * 200, 150 + depth * 300];
    const d = Math.min(depth * 1.5, 1);
    return [10 + (1 - d) * 15, 25 + (1 - d) * 30, 70 + (1 - d) * 50];
  }

  const e = Math.min(elev, 1);

  if (latDeg > 72) { const ice = 210 + e * 30; return [ice, ice + 5, ice + 12]; }
  if (latDeg > 55) {
    if (e > 0.5) return [140 + e * 40, 135 + e * 30, 120 + e * 20];
    return [45 + e * 20, 65 + e * 25 + (1 - (latDeg - 55) / 20) * 20, 35 + e * 10];
  }
  if (latDeg > 35) {
    if (e > 0.6) return [130 + e * 30, 125 + e * 25, 110 + e * 20];
    const variation = smoothNoise(lat * 10, e * 20) * 0.3;
    return [55 + variation * 30, 85 + e * 35 + variation * 15, 40 + variation * 10];
  }
  if (latDeg > 20) {
    const dryness = smoothNoise(lat * 8 + 2.5, e * 15 + 1.3);
    if (dryness > 0.55) { const d = (dryness - 0.55) / 0.45; return [170 + d * 40, 140 + d * 25, 80 + d * 15]; }
    return [50 + dryness * 20, 95 + e * 30, 35];
  }
  if (latDeg > 10) {
    const wetness = smoothNoise(lat * 6 + 3.7, e * 12 + 5.1);
    if (wetness < 0.45) return [130 + wetness * 30, 115 + wetness * 20, 60 + wetness * 15];
    return [35 + wetness * 15, 80 + e * 25, 28];
  }

  const jungle = smoothNoise(lat * 15 + 0.7, e * 18 + 2.3);
  return [25 + jungle * 20, 70 + e * 25 + jungle * 15, 22 + jungle * 10];
}

function generateEarthColor(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const elev = getElevation(lon, lat);
      const [r, g, b] = getPixelColor(elev, lat);
      data[idx] = Math.max(0, Math.min(255, r | 0));
      data[idx + 1] = Math.max(0, Math.min(255, g | 0));
      data[idx + 2] = Math.max(0, Math.min(255, b | 0));
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function generateRoughness(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const elev = getElevation(lon, lat);
      let rough: number;
      if (elev < 0) rough = 12 + Math.abs(elev) * 20;
      else if (Math.abs(lat) > 1.25) rough = 100;
      else rough = 160 + elev * 60;
      data[idx] = rough; data[idx + 1] = rough; data[idx + 2] = rough; data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function generateNormal(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const step = 0.003;
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const dx = (getElevation(lon + step, lat) - getElevation(lon - step, lat)) * 12;
      const dz = (getElevation(lon, lat + step * 0.5) - getElevation(lon, lat - step * 0.5)) * 12;
      data[idx] = Math.max(0, Math.min(255, 128 + dx * 50 | 0));
      data[idx + 1] = 255;
      data[idx + 2] = Math.max(0, Math.min(255, 128 + dz * 50 | 0));
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

// ── Globe creation ────────────────────────────────────────────────────

export interface GlobeHandle {
  mesh: THREE.Mesh;
  /** Set zoom level (0 = far, 18 = close). Maps to tile zoom internally. */
  setZoom(zoom: number): void;
  /** Get current tile zoom level */
  getZoom(): number;
  /** Whether tiles are still loading */
  isLoading(): boolean;
}

export function createGlobe(): GlobeHandle {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  // Procedural fallback textures
  const colorMap = generateEarthColor(1024, 512);
  const roughnessMap = generateRoughness(512, 256);
  const normalMap = generateNormal(512, 256);

  const material = new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughnessMap: roughnessMap,
    roughness: 0.8,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe';

  // Initialize tile streaming engine
  const tileEngine = createTileEngine();

  // Start loading tiles at initial zoom
  initTileTexture(mesh, tileEngine);

  // Map camera zoom (float) to tile zoom (int 1-6)
  function setZoom(cameraZoom: number): void {
    // cameraZoom is the "virtual zoom" from the camera (0-18 scale like a map).
    // We cap tile loading at MAX_ZOOM=6 (higher zooms would need more tiles
    // than we want to load in the browser).
    const tileZoom = Math.max(1, Math.min(6, Math.floor(cameraZoom)));
    tileEngine.setZoom(tileZoom);
  }

  function getZoom(): number {
    return tileEngine.getZoom();
  }

  function isLoading(): boolean {
    return tileEngine.isLoading();
  }

  return { mesh, setZoom, getZoom, isLoading };
}

/**
 * Initialize tile texture on the globe mesh.
 * Swaps the procedural texture for the streaming tile canvas once tiles start loading.
 */
async function initTileTexture(
  mesh: THREE.Mesh,
  tileEngine: TileEngine
): Promise<void> {
  try {
    // The tile engine starts loading immediately at zoom 2.
    // Wait a tick so at least the first batch of tiles arrives,
    // then swap the texture.
    await new Promise(resolve => setTimeout(resolve, 100));

    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.map = tileEngine.texture;
    mat.needsUpdate = true;
  } catch (e) {
    console.warn('Tile texture init failed, using procedural fallback:', e);
  }
}
