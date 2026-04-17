/**
 * Globe — Earth sphere with realistic procedural continents.
 * No external textures needed — generates recognizable Earth-like landmasses
 * using layered noise with continental shelf simulation.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371;

// ── Noise primitives ──────────────────────────────────────────────────

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

// ── Continent map ─────────────────────────────────────────────────────
// Uses multiple overlapping noise layers to create continent-like shapes
// with realistic coastlines, mountain ranges, and biome distribution.

function getElevation(lon: number, lat: number): number {
  // Map to UV space with wrapping
  const u = (lon + Math.PI) / (2 * Math.PI);
  const v = (lat + Math.PI / 2) / Math.PI;

  // === CONTINENTAL SHAPES ===
  // Layer 1: Large-scale continent placement
  // Using very low frequency noise to create ~5-6 major landmasses
  let continent = fbm(u * 2.5 + 0.3, v * 1.8 + 0.7, 5, 2.0, 0.55);

  // Layer 2: Secondary continent features
  continent += fbm(u * 4.0 + 3.14, v * 3.0 + 1.57, 4, 2.2, 0.45) * 0.4;

  // Layer 3: Ridged noise for peninsula/mountain-like features
  continent += ridged(u * 3.0 + 1.2, v * 2.5 + 2.8, 4) * 0.2;

  // Continent threshold — creates sharp coastlines
  // Values > threshold = land, < threshold = ocean
  const threshold = 0.52;
  let elev = (continent - threshold) * 4.0;
  elev = Math.max(-1, Math.min(1, elev));

  // === MOUNTAINS (on land only) ===
  if (elev > 0) {
    const mountains = ridged(u * 8.0 + 5.5, v * 6.0 + 3.3, 5) * 0.3;
    elev += mountains * elev; // more mountains where land is higher
  }

  // === ISLANDS (scattered in oceans) ===
  const islands = fbm(u * 12.0 + 7.7, v * 10.0 + 4.4, 4, 2.5, 0.4);
  if (elev < -0.3 && islands > 0.72) {
    elev = (islands - 0.72) * 3.0;
  }

  return elev;
}

// ── Biome coloring ────────────────────────────────────────────────────

function getPixelColor(elev: number, lat: number): [number, number, number] {
  const absLat = Math.abs(lat);
  const latDeg = absLat * (180 / Math.PI);

  if (elev < 0) {
    // === OCEAN ===
    const depth = Math.min(-elev, 1);
    // Shallow water near coasts
    if (depth < 0.15) {
      return [35, 100 + depth * 200, 150 + depth * 300];
    }
    // Deep ocean
    const d = Math.min(depth * 1.5, 1);
    return [10 + (1 - d) * 15, 25 + (1 - d) * 30, 70 + (1 - d) * 50];
  }

  // === LAND ===
  const e = Math.min(elev, 1);

  if (latDeg > 72) {
    // Polar ice
    const ice = 210 + e * 30;
    return [ice, ice + 5, ice + 12];
  }

  if (latDeg > 55) {
    // Boreal / tundra
    if (e > 0.5) return [140 + e * 40, 135 + e * 30, 120 + e * 20]; // alpine
    return [45 + e * 20, 65 + e * 25 + (1 - (latDeg - 55) / 20) * 20, 35 + e * 10];
  }

  if (latDeg > 35) {
    // Temperate
    if (e > 0.6) return [130 + e * 30, 125 + e * 25, 110 + e * 20]; // mountains
    const variation = smoothNoise(lat * 10, e * 20) * 0.3;
    return [55 + variation * 30, 85 + e * 35 + variation * 15, 40 + variation * 10];
  }

  if (latDeg > 20) {
    // Subtropical — drier
    const dryness = smoothNoise(lat * 8 + 2.5, e * 15 + 1.3);
    if (dryness > 0.55) {
      // Desert / savanna
      const d = (dryness - 0.55) / 0.45;
      return [170 + d * 40, 140 + d * 25, 80 + d * 15];
    }
    return [50 + dryness * 20, 95 + e * 30, 35];
  }

  if (latDeg > 10) {
    // Tropical savanna
    const wetness = smoothNoise(lat * 6 + 3.7, e * 12 + 5.1);
    if (wetness < 0.45) {
      // Dry season / savanna
      return [130 + wetness * 30, 115 + wetness * 20, 60 + wetness * 15];
    }
    return [35 + wetness * 15, 80 + e * 25, 28];
  }

  // Equatorial — dense rainforest
  const jungle = smoothNoise(lat * 15 + 0.7, e * 18 + 2.3);
  return [25 + jungle * 20, 70 + e * 25 + jungle * 15, 22 + jungle * 10];
}

// ── Texture generation ────────────────────────────────────────────────

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

      if (elev < 0) {
        // Ocean — smooth, specular
        rough = 12 + Math.abs(elev) * 20;
      } else if (Math.abs(lat) > 1.25) {
        // Ice — medium
        rough = 100;
      } else {
        // Land — rough
        rough = 160 + elev * 60;
      }

      data[idx] = rough;
      data[idx + 1] = rough;
      data[idx + 2] = rough;
      data[idx + 3] = 255;
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

      const hL = getElevation(lon - step, lat);
      const hR = getElevation(lon + step, lat);
      const hD = getElevation(lon, lat - step * 0.5);
      const hU = getElevation(lon, lat + step * 0.5);

      const dx = (hR - hL) * 12;
      const dz = (hU - hD) * 12;

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

export function createGlobe(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

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
  return mesh;
}
