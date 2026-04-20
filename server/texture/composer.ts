/**
 * Cloud Texture Composer — builds 2D intensity textures for volumetric rendering.
 *
 * Pipeline:
 *   1. Base field: Open-Meteo hourly cloudcover_low/mid/high (GFS model, full grid)
 *      Fallback: POWER CLOUD_OD → optical depth → density
 *      Fallback: procedural (ITCZ + storm tracks)
 *   2. Satellite detail: GOES visible/IR overlay (high-frequency shapes)
 *   3. Procedural noise: FBM + Worley for 3D structure
 *   4. Encode: smoothstep(0, 1, value) → single-channel intensity 0–1
 *
 * Output: Float32Array (width * height), values 0–1.
 */

import { fetchOpenMeteoCloudLayers } from '../sources/openmeteo';
import { fetchPOWERCloudData } from '../sources/power';
import { fetchGOESTexture } from '../sources/goes';

export interface CloudTexture {
  width: number;
  height: number;
  data: Float32Array;       // intensity 0-1
  windU: Float32Array;      // for advection
  windV: Float32Array;
  source: string;           // data provenance
  layers?: {
    low: Float32Array;
    medium: Float32Array;
    high: Float32Array;
  };
  timestamp: string;
}

/**
 * Build cloud texture for a tile region.
 */
export async function buildCloudTexture(
  tileLonMin: number,
  tileLonMax: number,
  tileLatMin: number,
  tileLatMax: number,
  textureWidth: number = 256,
  textureHeight: number = 256
): Promise<CloudTexture> {
  const centerLon = (tileLonMin + tileLonMax) / 2;
  const centerLat = (tileLatMin + tileLatMax) / 2;
  const time = new Date().toISOString();

  console.log(`[Texture] Building ${textureWidth}x${textureHeight} for tile (${tileLatMin.toFixed(1)}..${tileLatMax.toFixed(1)}, ${tileLonMin.toFixed(1)}..${tileLonMax.toFixed(1)})`);

  // ── Step 1: Base cloud field ────────────────────────────────────
  let baseField: Float32Array | null = null;
  let windU: Float32Array = new Float32Array(textureWidth * textureHeight);
  let windV: Float32Array = new Float32Array(textureWidth * textureHeight);
  let lowField: Float32Array | null = null;
  let midField: Float32Array | null = null;
  let highField: Float32Array | null = null;
  let source = '';

  // Primary: Open-Meteo (hourly cloudcover_low/mid/high from GFS model)
  try {
    const om = await fetchOpenMeteoCloudLayers(360, 180, 30);
    if (om) {
      baseField = extractTileRegion(om.cloudFraction, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      lowField = extractTileRegion(om.low, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      midField = extractTileRegion(om.medium, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      highField = extractTileRegion(om.high, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      windU = extractTileRegion(om.windU, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      windV = extractTileRegion(om.windV, 360, 180, tileLonMin, tileLonMax, tileLatMin, tileLatMax, textureWidth, textureHeight);
      source = 'Open-Meteo';
      console.log(`[Texture] Open-Meteo base: low/mid/high layers available`);
    }
  } catch (err) {
    console.warn(`[Texture] Open-Meteo failed: ${(err as Error).message}`);
  }

  // Fallback: POWER CLOUD_OD → density
  if (!baseField) {
    try {
      const power = await fetchPOWERCloudData(centerLat, centerLon, time);
      if (power?.optical_depth != null && power.optical_depth > 0) {
        const density = 1 - Math.exp(-power.optical_depth / 8);
        baseField = new Float32Array(textureWidth * textureHeight).fill(density);
        source = 'POWER';
        console.log(`[Texture] POWER base: OD=${power.optical_depth.toFixed(2)} → density=${density.toFixed(3)}`);
      }
    } catch (err) {
      console.warn(`[Texture] POWER failed: ${(err as Error).message}`);
    }
  }

  // Last resort: procedural
  if (!baseField) {
    baseField = generateProceduralBase(textureWidth, textureHeight, centerLat, centerLon);
    source = 'procedural';
    console.log('[Texture] Procedural fallback');
  }

  // ── Step 2: Satellite detail overlay ───────────────────────────
  try {
    const satTexture = await fetchGOESTexture(centerLon, centerLat, textureWidth, textureHeight);
    if (satTexture) {
      for (let i = 0; i < baseField.length; i++) {
        // Overlay blend: base * (1 + (sat - 0.5) * detail_scale)
        const detailScale = 0.3;
        baseField[i] = clamp(baseField[i] * (1 + (satTexture[i] - 0.5) * detailScale));
      }
      source += '+GOES';
      console.log('[Texture] Blended GOES satellite detail');
    }
  } catch {
    // Satellite is optional
  }

  // ── Step 3: Procedural noise detail ────────────────────────────
  applyNoise(baseField, textureWidth, textureHeight, centerLat, centerLon);

  // ── Step 4: Final smoothstep ───────────────────────────────────
  for (let i = 0; i < baseField.length; i++) {
    baseField[i] = smoothstep(baseField[i]);
  }

  return {
    width: textureWidth,
    height: textureHeight,
    data: baseField,
    windU,
    windV,
    source,
    timestamp: time,
    ...(lowField && midField && highField ? { layers: { low: lowField, medium: midField, high: highField } } : {}),
  };
}

// ── Tile region extraction (bilinear) ─────────────────────────────────

function extractTileRegion(
  grid: Float32Array, gridW: number, gridH: number,
  lonMin: number, lonMax: number, latMin: number, latMax: number,
  outW: number, outH: number
): Float32Array {
  const out = new Float32Array(outW * outH);
  for (let j = 0; j < outH; j++) {
    const lat = latMax - (j / outH) * (latMax - latMin);
    for (let i = 0; i < outW; i++) {
      const lon = lonMin + (i / outW) * (lonMax - lonMin);
      const gx = ((lon + 180) / 360) * gridW;
      const gy = ((90 - lat) / 180) * gridH;
      const x0 = Math.floor(gx) % gridW;
      const x1 = (x0 + 1) % gridW;
      const y0 = clampi(Math.floor(gy), 0, gridH - 1);
      const y1 = clampi(y0 + 1, 0, gridH - 1);
      const fx = gx - Math.floor(gx);
      const fy = gy - Math.floor(gy);
      const v00 = grid[y0 * gridW + x0] ?? 0;
      const v10 = grid[y0 * gridW + x1] ?? 0;
      const v01 = grid[y1 * gridW + x0] ?? 0;
      const v11 = grid[y1 * gridW + x1] ?? 0;
      out[j * outW + i] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    }
  }
  return out;
}

// ── Procedural base ───────────────────────────────────────────────────

function generateProceduralBase(w: number, h: number, cLat: number, cLon: number): Float32Array {
  const data = new Float32Array(w * h);
  const hour = new Date().getUTCHours();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const lat = cLat + (j / h - 0.5) * 10;
      const lon = cLon + (i / w - 0.5) * 10;
      const itcz = Math.exp(-lat * lat * 0.003) * 0.5;
      const storm = Math.exp(-Math.pow(Math.abs(Math.abs(lat) - 45), 2) * 0.005) * 0.4;
      const diurnal = Math.max(0, Math.sin(((hour - 14) / 24) * Math.PI * 2)) * 0.15;
      data[j * w + i] = clamp(itcz + storm + diurnal + noise2D(lon * 0.02, lat * 0.02) * 0.15);
    }
  }
  return data;
}

// ── Noise layer ───────────────────────────────────────────────────────

function applyNoise(data: Float32Array, w: number, h: number, cLat: number, cLon: number): void {
  const s = 0.05;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const x = (cLon + (i / w - 0.5) * 10) * s;
      const y = (cLat + (j / h - 0.5) * 10) * s;
      // 4-octave FBM
      let fbm = 0, amp = 1, freq = 1;
      for (let o = 0; o < 4; o++) { fbm += amp * noise2D(x * freq, y * freq); amp *= 0.5; freq *= 2; }
      fbm /= 1.875;
      // Worley
      const w2 = 1 - worley2D(x * 1.5, y * 1.5);
      const noise = fbm * 0.6 + w2 * 0.4;
      // Modulate by base density
      data[idx] = clamp(data[idx] * (1 + (noise - 0.5) * 0.25));
    }
  }
}

// ── Noise primitives ──────────────────────────────────────────────────

function noise2D(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + sx * (b - a)) + sy * ((c + sx * (d - c)) - (a + sx * (b - a)));
}

function worley2D(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let min = 1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const px = hash((ix + dx) * 73 + 17, (iy + dy) * 157 + 31);
    const py = hash((ix + dx) * 89 + 43, (iy + dy) * 131 + 67);
    min = Math.min(min, Math.hypot(dx + px - fx, dy + py - fy));
  }
  return min;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0x7fffffff) / 0x7fffffff;
}

// ── Utils ─────────────────────────────────────────────────────────────

function clamp(v: number): number { return Math.max(0, Math.min(1, v)); }
function clampi(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(v: number): number { const t = clamp(v); return t * t * (3 - 2 * t); }
