/**
 * SatelliteCoverage — Real-time global cloud coverage from satellite imagery.
 *
 * EVE approach: "Satellite cloud maps work well as coverage maps but they can
 * look flat and uniform inside the covered areas. For this reason I typically
 * layer them with noise."
 *
 * Data sources (fallback chain):
 *   1. NASA GIBS — VIIRS/MODIS Corrected Reflectance (free, no key, global)
 *      Uses WMS to fetch a single global image instead of tiling.
 *      Available products:
 *        - VIIRS_SNPP_CorrectedReflectance_TrueColor (daily, ~750m)
 *        - MODIS_Terra_CorrectedReflectance_TrueColor (daily, ~250m)
 *        - GOES-East/West ABI (geostationary, ~10 min, Americas/Asia-Pacific)
 *        - Himawari-8 AHI (geostationary, ~10 min, Asia-Pacific)
 *        - Meteosat (geostationary, ~15 min, Europe/Africa)
 *   2. Open-Meteo — cloud_cover model data (free, no key, hourly)
 *   3. Procedural noise — last resort
 *
 * Updates every 30 minutes.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface CoverageMap {
  /** Coverage values 0-1, row-major, width×height (lon×lat) */
  data: Float32Array;
  width: number;
  height: number;
  /** Timestamp of satellite data */
  timestamp: number;
  /** Data source identifier */
  source: string;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Output grid resolution */
const GRID_W = 360;
const GRID_H = 180;

/** Refresh interval: 30 minutes */
const REFRESH_INTERVAL = 30 * 60 * 1000;

/** WMS image size for global fetch (balance: detail vs bandwidth) */
const WMS_WIDTH = 1024;
const WMS_HEIGHT = 512;

/** Noise detail parameters */
const NOISE_OCTAVES = 4;
const NOISE_FREQUENCY = 6.0;
const NOISE_MIN_VALUE = 0.35; // EVE: "minimum value so it doesn't eat your cloud map"

// ── GIBS Configuration ─────────────────────────────────────────────────

/**
 * GIBS WMS layers for cloud imagery.
 * Direct cloud fraction products first (give us 0-1 values).
 */
const GIBS_LAYERS = [
  // MODIS Cloud Fraction — direct 0-100% cloud fraction, color-mapped
  {
    id: 'MODIS_Terra_Cloud_Fraction_Day',
    name: 'MODIS Cloud Fraction',
    tileMatrix: '1km',
    temporal: 'daily',
    isDirectProduct: true,
  },
  // MODIS Cloud Optical Thickness — direct cloud thickness
  {
    id: 'MODIS_Terra_Cloud_Optical_Thickness_Day',
    name: 'MODIS Cloud Optical Thickness',
    tileMatrix: '1km',
    temporal: 'daily',
    isDirectProduct: true,
  },
  // VIIRS True Color — fallback, visual cloud detection
  {
    id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    name: 'VIIRS SNPP True Color',
    tileMatrix: '250m',
    temporal: 'daily',
    isDirectProduct: false,
  },
];

/**
 * GIBS WMS endpoint for EPSG:4326 (geographic, lat/lon).
 * This matches our 360×180 grid perfectly.
 */
const GIBS_WMS_BASE = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

// ── Noise Generation ───────────────────────────────────────────────────

function hash2D(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smoothstep(x - ix), fy = smoothstep(y - iy);
  return hash2D(ix, iy)     * (1-fx) * (1-fy)
       + hash2D(ix+1, iy)   * fx     * (1-fy)
       + hash2D(ix, iy+1)   * (1-fx) * fy
       + hash2D(ix+1, iy+1) * fx     * fy;
}

function fbm(x: number, y: number, octaves: number, lacunarity: number = 2.0, gain: number = 0.5): number {
  let value = 0, amp = 1, freq = 1, maxVal = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * valueNoise(x * freq, y * freq);
    maxVal += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return value / maxVal;
}

function worleyNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let minDist = 1.0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = hash2D((ix+dx)*73+17, (iy+dy)*157+31);
      const py = hash2D((ix+dx)*89+43, (iy+dy)*131+67);
      minDist = Math.min(minDist, Math.sqrt((dx+px-fx)**2 + (dy+py-fy)**2));
    }
  }
  return minDist;
}

/**
 * Generate Perlin-Worley noise texture.
 * EVE: "simple perlin noise at the right frequency is enough to start"
 */
function generateDetailNoise(width: number, height: number, seed: number): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 3.71, oy = seed * 2.39;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * NOISE_FREQUENCY;
      const v = (j / height) * (NOISE_FREQUENCY * 0.5);

      const perlin = fbm(u + ox, v + oy, NOISE_OCTAVES);
      const worley = 1.0 - worleyNoise(u * 1.5 + ox, v * 1.5 + oy);
      const detail = fbm(u * 4 + ox * 2, v * 4 + oy * 2, 3);

      let noise = perlin * 0.5 + worley * 0.35 + detail * 0.15;

      // EVE: "set the minimum value of the noise to be a middle value
      // instead of 0 so it doesn't eat your cloud map"
      noise = NOISE_MIN_VALUE + noise * (1.0 - NOISE_MIN_VALUE);

      data[j * width + i] = Math.max(0, Math.min(1, noise));
    }
  }
  return data;
}

// ── GIBS WMS Fetching ──────────────────────────────────────────────────

/**
 * Build a GIBS WMS GetMap URL for a global image.
 *
 * WMS gives us a single image for the entire globe — no tiling needed.
 * Format: PNG, EPSG:4326, global bbox -180,-90,180,90
 */
function buildGibsWmsUrl(layerId: string, date: string): string {
  const params = new URLSearchParams({
    service: 'WMS',
    request: 'GetMap',
    version: '1.1.1',
    layers: layerId,
    styles: 'default',
    format: 'image/png',
    transparent: 'true',
    width: String(WMS_WIDTH),
    height: String(WMS_HEIGHT),
    srs: 'EPSG:4326',
    bbox: '-180,-90,180,90',
    time: date,
  });
  return `${GIBS_WMS_BASE}?${params.toString()}`;
}

/**
 * Get today's date in YYYY-MM-DD format for GIBS time parameter.
 */
function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get yesterday's date (GIBS data may lag by a day).
 */
function getYesterdayString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Try to fetch a global satellite image from GIBS.
 * Attempts multiple layers and dates until one succeeds.
 */
async function fetchGibsImage(): Promise<{ imageData: ImageData; layer: string; isDirectProduct: boolean } | null> {
  const dates = [getTodayString(), getYesterdayString()];

  for (const layer of GIBS_LAYERS) {
    for (const date of dates) {
      const url = buildGibsWmsUrl(layer.id, date);

      try {
        const result = await fetchAndExtractPixels(url);
        if (result) {
          // Check for "no data" — all pixels are black/transparent
          const hasData = checkImageData(result);
          if (!hasData) {
            console.log(`[SatCoverage] ${layer.name} @ ${date}: no data (all black)`);
            continue;
          }
          console.log(`[SatCoverage] GIBS loaded: ${layer.name} @ ${date}`);
          return { imageData: result, layer: layer.name, isDirectProduct: layer.isDirectProduct ?? false };
        }
      } catch (e) {
        continue;
      }
    }
  }

  return null;
}

/**
 * Check if an image has actual data (not all black/zero).
 */
function checkImageData(imageData: ImageData): boolean {
  const { data } = imageData;
  let nonZero = 0;
  const sampleStep = 64; // sample every 64th pixel for speed
  for (let i = 0; i < data.length; i += sampleStep * 4) {
    if (data[i] > 5 || data[i+1] > 5 || data[i+2] > 5) nonZero++;
  }
  const totalSampled = Math.floor(data.length / (sampleStep * 4));
  return nonZero > totalSampled * 0.01; // at least 1% non-zero pixels
}

/**
 * Fetch an image URL and extract pixel data.
 * Handles CORS and cross-origin issues.
 */
async function fetchAndExtractPixels(url: string): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const timeout = setTimeout(() => {
      resolve(null);
    }, 15000);

    img.onload = () => {
      clearTimeout(timeout);

      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width || WMS_WIDTH;
        canvas.height = img.height || WMS_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(imageData);
      } catch (e) {
        // Likely CORS or tainted canvas
        console.warn('[SatCoverage] Canvas extraction failed (CORS?):', e);
        resolve(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };

    img.src = url;
  });
}

// ── Pixel → Coverage Conversion ────────────────────────────────────────

/**
 * Convert satellite image pixels to cloud coverage map.
 *
 * For direct cloud products (MODIS Cloud Fraction):
 *   Color-mapped: R channel encodes cloud fraction (purple=0%, red=100%)
 *
 * For true-color imagery (VIIRS/MODIS Corrected Reflectance):
 *   Clouds are bright + low saturation, land/ocean is darker
 */
function pixelsToCoverage(imageData: ImageData, isDirectProduct: boolean = false): Float32Array {
  const { data, width, height } = imageData;
  const coverage = new Float32Array(GRID_W * GRID_H);

  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const px = Math.floor((i / GRID_W) * width);
      const py = Math.floor((j / GRID_H) * height);
      const pIdx = (py * width + px) * 4;

      const r = data[pIdx];
      const g = data[pIdx + 1];
      const b = data[pIdx + 2];
      const a = data[pIdx + 3];

      // Skip transparent pixels (no data)
      if (a < 10) {
        coverage[j * GRID_W + i] = 0;
        continue;
      }

      // Skip all-black pixels (no satellite data for this area)
      if (r + g + b === 0) {
        coverage[j * GRID_W + i] = 0;
        continue;
      }

      let cloudScore: number;

      if (isDirectProduct) {
        // Direct cloud product (e.g., MODIS Cloud Fraction)
        // Color ramp: purple(0%) → cyan(50%) → red(100%)
        // Red channel is the primary indicator
        cloudScore = r / 255;

        // Refine with other channels:
        // Pure purple (low CF): high B, low R
        // Pure red (high CF): high R, low B
        // Adjust: when B is high and R is low, it's very low CF
        if (b > r && b > 100) {
          cloudScore = Math.min(cloudScore, 0.3);
        }
      } else {
        // Visual imagery: brightness + saturation analysis
        const brightness = (r + g + b) / (3 * 255);
        const maxCh = Math.max(r, g, b);
        const minCh = Math.min(r, g, b);
        const saturation = maxCh > 0 ? (maxCh - minCh) / maxCh : 0;
        cloudScore = brightness * (1.0 - saturation * 0.7);
      }

      coverage[j * GRID_W + i] = Math.max(0, Math.min(1, cloudScore));
    }
  }

  return coverage;
}

// ── Blend Satellite + Noise (EVE approach) ─────────────────────────────

/**
 * "layer [satellite maps] with noise, set the minimum value of the noise
 *  to be a middle value instead of 0 so it doesn't eat your cloud map"
 *
 * blended = satellite * satelliteWeight + noise * (1 - satelliteWeight)
 * But: noise only adds texture WITHIN cloudy regions (where satellite > 0)
 */
function blendWithNoise(
  satellite: Float32Array,
  noise: Float32Array,
  satelliteWeight: number = 0.75
): Float32Array {
  const result = new Float32Array(satellite.length);
  for (let i = 0; i < satellite.length; i++) {
    const sat = satellite[i];
    const n = noise[i];

    if (sat < 0.05) {
      // Clear sky: noise can't create clouds from nothing
      result[i] = sat * 0.9;
    } else {
      // Cloudy: blend satellite shape with noise texture
      result[i] = sat * satelliteWeight + n * (1 - satelliteWeight) * sat;
    }
  }
  return result;
}

// ── Open-Meteo Fallback ────────────────────────────────────────────────

/**
 * Fetch cloud coverage from Open-Meteo as fallback.
 * Global grid of sample points, interpolated.
 */
async function fetchOpenMeteoCoverage(): Promise<Float32Array | null> {
  try {
    const lats: number[] = [];
    const lons: number[] = [];
    for (let lat = -75; lat <= 75; lat += 15) lats.push(lat);
    for (let lon = -180; lon < 180; lon += 15) lons.push(lon);

    const points: Array<{ lat: number; lon: number; cloud: number }> = [];

    for (let batch = 0; batch < lats.length * lons.length; batch += 25) {
      const bLats: number[] = [], bLons: number[] = [];
      for (let idx = batch; idx < Math.min(batch + 25, lats.length * lons.length); idx++) {
        bLats.push(lats[Math.floor(idx / lons.length)]);
        bLons.push(lons[idx % lons.length]);
      }

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${bLats.join(',')}&longitude=${bLons.join(',')}&current=cloud_cover&timezone=GMT`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      const results = Array.isArray(data) ? data : [data];
      for (let i = 0; i < results.length && i < bLats.length; i++) {
        points.push({
          lat: bLats[i], lon: bLons[i],
          cloud: (results[i]?.current?.cloud_cover ?? 0) / 100,
        });
      }

      if (batch + 25 < lats.length * lons.length) await new Promise(r => setTimeout(r, 500));
    }

    if (points.length < 10) return null;

    // Inverse distance weighting interpolation
    const coverage = new Float32Array(GRID_W * GRID_H);
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        const lon = (i / GRID_W) * 360 - 180;
        const lat = 90 - (j / GRID_H) * 180;
        let wSum = 0, vSum = 0;
        for (const pt of points) {
          const d = (lat - pt.lat) ** 2 + (lon - pt.lon) ** 2;
          if (d < 0.001) { vSum = pt.cloud; wSum = 1; break; }
          const w = 1 / d;
          vSum += pt.cloud * w;
          wSum += w;
        }
        coverage[j * GRID_W + i] = wSum > 0 ? vSum / wSum : 0;
      }
    }

    return coverage;
  } catch {
    return null;
  }
}

// ── Meteorological Priors ──────────────────────────────────────────────

function applyPriors(coverage: Float32Array): Float32Array {
  const result = new Float32Array(coverage);
  for (let j = 0; j < GRID_H; j++) {
    const lat = 90 - (j / GRID_H) * 180;
    const absLat = Math.abs(lat);

    for (let i = 0; i < GRID_W; i++) {
      const idx = j * GRID_W + i;
      // ITCZ
      const itcz = Math.exp(-absLat * absLat * 0.01) * 0.12;
      // Storm tracks
      const storm30 = Math.exp(-Math.pow(absLat - 30, 2) * 0.02) * 0.06;
      const storm60 = Math.exp(-Math.pow(absLat - 60, 2) * 0.02) * 0.04;
      // Polar penalty
      const polar = absLat > 70 ? -0.08 * ((absLat - 70) / 20) : 0;

      result[idx] = Math.max(0, Math.min(1, result[idx] + itcz + storm30 + storm60 + polar));
    }
  }
  return result;
}

// ── Main Class ─────────────────────────────────────────────────────────

export class SatelliteCoverage {
  private current: CoverageMap | null = null;
  private detailNoise: Float32Array | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private isLoading = false;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor() {
    this.detailNoise = generateDetailNoise(GRID_W, GRID_H, Math.floor(Date.now() / 3600000));
  }

  getCoverage(): CoverageMap | null { return this.current; }
  getDetailNoise(): Float32Array | null { return this.detailNoise; }

  startAutoRefresh(): void {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL);
    console.log('[SatCoverage] Auto-refresh started (30-min interval)');
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  async refresh(): Promise<CoverageMap | null> {
    if (this.isLoading) return this.current;
    this.isLoading = true;
    console.log('[SatCoverage] Refreshing global cloud coverage...');

    let coverage: Float32Array | null = null;
    let source = 'none';

    // ── 1. NASA GIBS satellite imagery ─────────────────────────────
    try {
      const gibResult = await fetchGibsImage();
      if (gibResult) {
        coverage = pixelsToCoverage(gibResult.imageData, gibResult.isDirectProduct);
        source = `GIBS (${gibResult.layer})`;
        console.log('[SatCoverage] GIBS satellite data loaded');
      }
    } catch (e) {
      console.warn('[SatCoverage] GIBS failed:', e);
    }

    // ── 2. Open-Meteo cloud_cover ──────────────────────────────────
    if (!coverage) {
      console.log('[SatCoverage] Trying Open-Meteo fallback...');
      coverage = await fetchOpenMeteoCoverage();
      if (coverage) {
        source = 'Open-Meteo';
        console.log('[SatCoverage] Open-Meteo cloud data loaded');
      }
    }

    // ── 3. Procedural noise ────────────────────────────────────────
    if (!coverage) {
      console.log('[SatCoverage] Using procedural noise only');
      const seed = Math.floor(Date.now() / 3600000);
      this.detailNoise = generateDetailNoise(GRID_W, GRID_H, seed);
      coverage = this.detailNoise;
      source = 'Procedural';
    }

    // ── Layer with detail noise (EVE approach) ─────────────────────
    if (source !== 'Procedural' && this.detailNoise) {
      coverage = blendWithNoise(coverage, this.detailNoise, 0.75);
      source += '+Noise';
    }

    // ── Apply priors ───────────────────────────────────────────────
    coverage = applyPriors(coverage);

    this.current = {
      data: coverage,
      width: GRID_W,
      height: GRID_H,
      timestamp: Date.now(),
      source,
    };

    this.isLoading = false;
    this.emit('coverageUpdated', this.current);
    console.log(`[SatCoverage] ✅ Coverage updated: ${source}`);
    return this.current;
  }

  on(event: string, fn: Function): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  off(event: string, fn: Function): void {
    this.listeners.get(event)?.delete(fn);
  }

  private emit(event: string, data?: any): void {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }

  destroy(): void {
    this.stopAutoRefresh();
    this.listeners.clear();
  }
}
