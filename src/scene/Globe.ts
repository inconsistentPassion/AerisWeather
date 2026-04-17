/**
 * Globe — Earth sphere with realistic continent shapes.
 * Uses multi-octave noise to generate recognizable landmasses.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371; // km, arbitrary units

// ── Improved noise functions ──────────────────────────────────────────

function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);
  return n00 + sx * (n10 - n00) + sy * (n01 - n00) + sx * sy * (n00 - n10 - n01 + n11);
}

function fbm(x: number, y: number, octaves: number): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * smoothNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

function ridgedNoise(x: number, y: number, octaves: number): number {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(smoothNoise(x * freq, y * freq) * 2 - 1);
    val += amp * n * n;
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

/**
 * Continent generation using shaped noise.
 * Creates recognizable land/ocean patterns with latitude-based biomes.
 */
function getTerrainHeight(lon: number, lat: number): number {
  // Normalize to 0-1 range
  const nx = (lon + Math.PI) / (2 * Math.PI);
  const ny = (lat + Math.PI / 2) / Math.PI;

  // Base continent shapes — multiple overlapping blobs
  let continent = 0;

  // Large continental masses
  continent += Math.pow(fbm(nx * 3 + 0.5, ny * 2.5 + 0.3, 5), 1.5) * 0.6;

  // Ridge noise for coastlines
  continent += ridgedNoise(nx * 4 + 2.1, ny * 3 + 1.7, 4) * 0.25;

  // Fine detail
  continent += fbm(nx * 8 + 5.3, ny * 6 + 3.1, 3) * 0.15;

  // Continent threshold — push toward binary land/ocean
  continent = (continent - 0.42) * 3;
  continent = Math.max(-1, Math.min(1, continent));

  return continent;
}

/**
 * Biome color based on latitude and terrain height.
 */
function getBiomeColor(lat: number, height: number): [number, number, number] {
  const absLat = Math.abs(lat);
  const latDeg = absLat * (180 / Math.PI);

  if (height < 0) {
    // Ocean — depth-based coloring
    const depth = -height;
    const shallow = depth < 0.15;
    if (shallow) {
      // Shallow/coastal — lighter blue-green
      return [30 + depth * 100, 90 + depth * 80, 140 + depth * 60];
    }
    // Deep ocean
    const d = Math.min(depth, 1);
    return [8 + d * 5, 20 + d * 15, 60 + d * 40];
  }

  // Land
  if (latDeg > 75) {
    // Polar ice/snow
    const ice = 200 + height * 30;
    return [ice, ice + 5, ice + 10];
  }

  if (latDeg > 55) {
    // Boreal/taiga — dark green to tundra
    const tundra = Math.max(0, (latDeg - 55) / 20);
    const g = 60 + height * 30 - tundra * 40;
    return [50 + tundra * 100, g, 35 + tundra * 80];
  }

  if (latDeg > 35) {
    // Temperate — green with variation
    const n = fbm(lat * 5, height * 3, 3);
    return [60 + n * 30, 90 + height * 40 + n * 20, 40 + n * 15];
  }

  if (latDeg > 15) {
    // Subtropical — mix of green and dry
    const dryness = fbm(lat * 2 + 1.5, height * 2, 3);
    if (dryness > 0.5) {
      // Desert/savanna
      return [160 + dryness * 40, 130 + dryness * 30, 80 + dryness * 20];
    }
    return [50 + dryness * 20, 100 + height * 30, 35];
  }

  // Tropical — dense green
  const jungle = fbm(lat * 3 + 0.7, height * 4 + 2.3, 4);
  return [30 + jungle * 25, 80 + height * 30 + jungle * 20, 25 + jungle * 15];
}

// ── Texture generation ────────────────────────────────────────────────

export function createGlobe(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  const colorMap = generateEarthTexture(2048, 1024);
  const normalMap = generateNormalMap(1024, 512);
  const roughnessMap = generateRoughnessMap(1024, 512);

  const material = new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughnessMap: roughnessMap,
    roughness: 0.8,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe';
  return mesh;
}

function generateEarthTexture(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;

      const height = getTerrainHeight(lon, lat);
      const [r, g, b] = getBiomeColor(lat, height);

      data[idx] = Math.floor(Math.max(0, Math.min(255, r)));
      data[idx + 1] = Math.floor(Math.max(0, Math.min(255, g)));
      data[idx + 2] = Math.floor(Math.max(0, Math.min(255, b)));
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function generateNormalMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const scale = 2;

  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;

      // Height gradient for normal
      const hL = getTerrainHeight(lon - scale / w * Math.PI * 2, lat);
      const hR = getTerrainHeight(lon + scale / w * Math.PI * 2, lat);
      const hD = getTerrainHeight(lon, lat - scale / h * Math.PI);
      const hU = getTerrainHeight(lon, lat + scale / h * Math.PI);

      const dx = (hR - hL) * 8;
      const dz = (hU - hD) * 8;

      data[idx] = Math.floor(128 + dx * 60);
      data[idx + 1] = 255;
      data[idx + 2] = Math.floor(128 + dz * 60);
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function generateRoughnessMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;

      const height = getTerrainHeight(lon, lat);

      // Ocean = smooth (low roughness), Land = rough (high roughness)
      const roughness = height < 0 ? 0.08 + Math.abs(height) * 0.15 : 0.65 + height * 0.2;
      const val = Math.floor(Math.max(0, Math.min(255, roughness * 255)));

      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
