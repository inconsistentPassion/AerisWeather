/**
 * Cloud Texture Composer — builds 2D intensity textures for volumetric rendering.
 *
 * Pipeline:
 *   1. Base field: GFS cloud fraction (per-level weighted sum)
 *      Fallback: Open-Meteo hourly cloudcover_low/mid/high
 *      Fallback: POWER CLOUD_OD → optical depth → density
 *      Fallback: procedural
 *   2. Satellite detail: GOES visible/IR overlay (high-frequency shapes)
 *   3. Procedural noise: FBM + Worley for 3D structure
 *   4. Encode: single-channel float, normalized 0–1
 *
 * Output: Float32Array (width * height), values 0–1, where
 *   value = base cloud density seed for volumetric shader input.
 */

import { fetchGFSPointCloud, getCurrentCycle } from '../sources/gfs';
import { fetchOpenMeteoCloudLayers } from '../sources/openmeteo';
import { fetchPOWERCloudData } from '../sources/power';
import { fetchGOESFrame } from '../sources/goes';

export interface CloudTexture {
  width: number;
  height: number;
  data: Float32Array;    // intensity 0-1
  windU: Float32Array;   // for advection
  windV: Float32Array;
  source: string;        // data provenance
  layers?: {
    low: Float32Array;
    medium: Float32Array;
    high: Float32Array;
  };
  timestamp: string;
}

/** Weights for combining pressure-level cloud fractions into visual density */
const LEVEL_WEIGHTS: Record<number, number> = {
  1000: 0.05,
  925: 0.10,
  850: 0.15,
  700: 0.20,
  600: 0.15,
  500: 0.12,
  400: 0.08,
  300: 0.06,
  250: 0.04,
  200: 0.03,
  150: 0.01,
  100: 0.01,
};

/**
 * Build cloud texture for a tile region.
 *
 * @param tileLonMin  Tile west edge (degrees)
 * @param tileLonMax  Tile east edge
 * @param tileLatMin  Tile south edge
 * @param tileLatMax  Tile north edge
 * @param textureWidth  Output texture width in pixels
 * @param textureHeight Output texture height in pixels
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

  console.log(`[Texture] Building cloud texture for (${tileLatMin.toFixed(1)}..${tileLatMax.toFixed(1)}, ${tileLonMin.toFixed(1)}..${tileLonMax.toFixed(1)})`);

  // ── Step 1: Get base cloud field ───────────────────────────────
  let baseField: Float32Array | null = null;
  let windU: any = new Float32Array(textureWidth * textureHeight);
  let windV: any = new Float32Array(textureWidth * textureHeight);
  let lowField: Float32Array | null = null;
  let midField: Float32Array | null = null;
  let highField: Float32Array | null = null;
  let source = 'unknown';

  // Try GFS (server-side point extraction → grid)
  try {
    const cycle = getCurrentCycle();
    const fhour = 3; // nearest forecast
    const gfsData = await fetchGFSPointCloud(cycle, fhour, centerLat, centerLon);

    if (gfsData && gfsData.levels.length > 0) {
      // Compute weighted cloud fraction from pressure levels
      let totalWeight = 0;
      let weightedCF = 0;
      for (let i = 0; i < gfsData.levels.length; i++) {
        const w = LEVEL_WEIGHTS[gfsData.levels[i]] ?? 0.05;
        weightedCF += gfsData.cloud_fraction[i] * w;
        totalWeight += w;
      }
      const cf = totalWeight > 0 ? weightedCF / totalWeight : 0;

      // Fill tile with this value (point query → uniform tile)
      // In a full implementation, we'd query multiple points across the tile
      baseField = new Float32Array(textureWidth * textureHeight).fill(cf);
      source = 'GFS';
      console.log(`[Texture] GFS base: cf=${cf.toFixed(3)} from ${gfsData.levels.length} levels`);
    }
  } catch (err) {
    console.warn(`[Texture] GFS failed: ${(err as Error).message}`);
  }

  // Fallback: Open-Meteo hourly cloud layers
  if (!baseField) {
    try {
      const omData = await fetchOpenMeteoCloudLayers(textureWidth, textureHeight, 30);
      if (omData) {
        // Crop to tile region
        baseField = extractTileRegion(omData.cloudFraction, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        lowField = extractTileRegion(omData.low, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        midField = extractTileRegion(omData.medium, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        highField = extractTileRegion(omData.high, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        windU = extractTileRegion(omData.windU, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        windV = extractTileRegion(omData.windV, 360, 180,
          tileLonMin, tileLonMax, tileLatMin, tileLatMax,
          textureWidth, textureHeight);
        source = 'Open-Meteo';
        console.log('[Texture] Open-Meteo base with low/mid/high layers');
      }
    } catch (err) {
      console.warn(`[Texture] Open-Meteo failed: ${(err as Error).message}`);
    }
  }

  // Fallback: POWER CLOUD_OD → optical depth → density
  if (!baseField) {
    try {
      const powerData = await fetchPOWERCloudData(centerLat, centerLon, time);
      if (powerData && powerData.optical_depth !== null) {
        // τ → perceptual density: base = 1 - exp(-τ / k) with k=8
        const density = 1 - Math.exp(-powerData.optical_depth / 8);
        baseField = new Float32Array(textureWidth * textureHeight).fill(density);
        source = 'POWER';
        console.log(`[Texture] POWER base: OD=${powerData.optical_depth.toFixed(2)} → density=${density.toFixed(3)}`);
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
    const goesFrame = await fetchGOESFrame(centerLon, centerLat, 13);
    if (goesFrame && goesFrame.data.length > 0) {
      // Blend GOES detail with base field
      // GOES data is 256x256, resize if needed
      const satDetail = goesFrame.data;

      for (let i = 0; i < baseField.length; i++) {
        const sx = (i % textureWidth) / textureWidth;
        const sy = Math.floor(i / textureWidth) / textureHeight;
        const satX = Math.floor(sx * goesFrame.width);
        const satY = Math.floor(sy * goesFrame.height);
        const satVal = satDetail[satY * goesFrame.width + satX] ?? 0.5;

        // Overlay blend: base * (1 + (sat - 0.5) * detail_scale)
        const detailScale = 0.3;
        baseField[i] = Math.max(0, Math.min(1,
          baseField[i] * (1 + (satVal - 0.5) * detailScale)
        ));
      }
      source += `+${goesFrame.source}`;
      console.log(`[Texture] Blended ${goesFrame.source} detail`);
    }
  } catch (err) {
    // Satellite is optional — continue without it
  }

  // ── Step 3: Procedural noise detail ────────────────────────────
  applyProceduralNoise(baseField, textureWidth, textureHeight, centerLat, centerLon);

  // ── Step 4: Final normalization ────────────────────────────────
  // smoothstep(0, 1, base)
  for (let i = 0; i < baseField.length; i++) {
    const t = Math.max(0, Math.min(1, baseField[i]));
    baseField[i] = t * t * (3 - 2 * t); // smoothstep
  }

  const texture: CloudTexture = {
    width: textureWidth,
    height: textureHeight,
    data: baseField,
    windU,
    windV,
    source,
    timestamp: time,
  };

  if (lowField && midField && highField) {
    texture.layers = { low: lowField, medium: midField, high: highField };
  }

  return texture;
}

/**
 * Extract a tile region from a lat/lon grid via bilinear interpolation.
 */
function extractTileRegion(
  grid: Float32Array,
  gridWidth: number,
  gridHeight: number,
  lonMin: number,
  lonMax: number,
  latMin: number,
  latMax: number,
  outWidth: number,
  outHeight: number
): Float32Array {
  const result = new Float32Array(outWidth * outHeight);

  for (let j = 0; j < outHeight; j++) {
    const lat = latMax - (j / outHeight) * (latMax - latMin);
    for (let i = 0; i < outWidth; i++) {
      const lon = lonMin + (i / outWidth) * (lonMax - lonMin);

      // Map to grid indices
      const gx = ((lon + 180) / 360) * gridWidth;
      const gy = ((90 - lat) / 180) * gridHeight;

      const x0 = Math.floor(gx) % gridWidth;
      const x1 = (x0 + 1) % gridWidth;
      const y0 = Math.max(0, Math.min(gridHeight - 1, Math.floor(gy)));
      const y1 = Math.max(0, Math.min(gridHeight - 1, y0 + 1));

      const fx = gx - Math.floor(gx);
      const fy = gy - Math.floor(gy);

      const v00 = grid[y0 * gridWidth + x0] ?? 0;
      const v10 = grid[y0 * gridWidth + x1] ?? 0;
      const v01 = grid[y1 * gridWidth + x0] ?? 0;
      const v11 = grid[y1 * gridWidth + x1] ?? 0;

      result[j * outWidth + i] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
                                  v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }

  return result;
}

/**
 * Generate procedural base field (ITCZ + storm tracks + diurnal).
 */
function generateProceduralBase(
  width: number,
  height: number,
  centerLat: number,
  centerLon: number
): Float32Array {
  const data = new Float32Array(width * height);
  const hour = new Date().getUTCHours();

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const lat = centerLat + (j / height - 0.5) * 10; // ~10° tile
      const lon = centerLon + (i / width - 0.5) * 10;

      const itcz = Math.exp(-lat * lat * 0.003) * 0.5;
      const storm = Math.exp(-Math.pow(Math.abs(Math.abs(lat) - 45), 2) * 0.005) * 0.4;
      const diurnal = Math.max(0, Math.sin(((hour - 14) / 24) * Math.PI * 2)) * 0.15;
      const noise = valueNoise(lon * 0.02, lat * 0.02) * 0.15;

      data[j * width + i] = Math.max(0, Math.min(1, itcz + storm + diurnal + noise));
    }
  }

  return data;
}

/**
 * Apply multi-octave FBM + Worley noise for cloud texture detail.
 * Amplitude modulated by base field (stronger where clouds are thicker).
 */
function applyProceduralNoise(
  data: Float32Array,
  width: number,
  height: number,
  centerLat: number,
  centerLon: number
): void {
  const scale = 0.05;
  const detailScale = 0.25;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const idx = j * width + i;
      const x = (centerLon + (i / width - 0.5) * 10) * scale;
      const y = (centerLat + (j / height - 0.5) * 10) * scale;

      // FBM (4 octaves)
      let fbm = 0;
      let amp = 1;
      let freq = 1;
      for (let o = 0; o < 4; o++) {
        fbm += amp * valueNoise(x * freq, y * freq);
        amp *= 0.5;
        freq *= 2;
      }
      fbm /= 1.875;

      // Worley
      const worley = 1 - worleyNoise(x * 1.5, y * 1.5);

      // Combine noise
      const noise = fbm * 0.6 + worley * 0.4;

      // Modulate amplitude by base density
      const base = data[idx];
      const modulated = base * (1 + (noise - 0.5) * detailScale);

      data[idx] = Math.max(0, Math.min(1, modulated));
    }
  }
}

// ── Noise primitives ──────────────────────────────────────────────────

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const n00 = hash(ix, iy), n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1), n11 = hash(ix + 1, iy + 1);
  return (n00 + sx * (n10 - n00)) + sy * ((n01 + sx * (n11 - n01)) - (n00 + sx * (n10 - n00)));
}

function worleyNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let minDist = 1.0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const px = hash(cx * 73 + 17, cy * 157 + 31);
      const py = hash(cx * 89 + 43, cy * 131 + 67);
      const dist = Math.sqrt((dx + px - fx) ** 2 + (dy + py - fy) ** 2);
      minDist = Math.min(minDist, dist);
    }
  }
  return minDist;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}
