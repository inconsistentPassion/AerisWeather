/**
 * LiveCloudMap — Real-time global cloud coverage from matteason/live-cloud-maps.
 *
 * Uses EUMETSAT satellite data composited into a greyscale cloud map.
 * Updated every 3 hours, CORS enabled, free.
 *
 * EVE approach: satellite map as coverage map, layered with noise for detail.
 *
 * Source: https://github.com/matteason/live-cloud-maps
 * "Contains modified EUMETSAT data"
 */

// ── Config ─────────────────────────────────────────────────────────────

/** Cloud map URL — always latest, auto-updated every 3 hours */
const CLOUD_MAP_URL = 'https://clouds.matteason.co.uk/images/1024x512/clouds.jpg';

/** Refresh interval: match the 3-hour update cadence */
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000;

/** Output grid size */
const GRID_W = 360;
const GRID_H = 180;

/** Noise layer parameters */
const NOISE_MIN_VALUE = 0.20; // noise floor — adds texture without creating clouds from nothing
const NOISE_BLEND = 0.30;     // how much noise contributes (30%)

// ── Types ──────────────────────────────────────────────────────────────

export interface CoverageMap {
  data: Float32Array;
  width: number;
  height: number;
  timestamp: number;
  source: string;
}

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

function fbm(x: number, y: number, octaves: number): number {
  let value = 0, amp = 1, freq = 1, maxVal = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * valueNoise(x * freq, y * freq);
    maxVal += amp; amp *= 0.5; freq *= 2.0;
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
 * Generate detail noise texture.
 * EVE: "simple perlin noise at the right frequency is enough to start"
 */
function generateNoise(width: number, height: number, seed: number): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 3.71, oy = seed * 2.39;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6;
      const v = (j / height) * 3;

      const perlin = fbm(u + ox, v + oy, 4);
      const worley = 1.0 - worleyNoise(u * 1.5 + ox, v * 1.5 + oy);
      const detail = fbm(u * 4 + ox * 2, v * 4 + oy * 2, 3);

      let noise = perlin * 0.5 + worley * 0.35 + detail * 0.15;

      // EVE: minimum value so noise doesn't eat the cloud map
      noise = NOISE_MIN_VALUE + noise * (1.0 - NOISE_MIN_VALUE);

      data[j * width + i] = Math.max(0, Math.min(1, noise));
    }
  }
  return data;
}

// ── Image Fetching ─────────────────────────────────────────────────────

/**
 * Fetch the live cloud map and extract pixel data.
 */
async function fetchCloudMap(): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const timeout = setTimeout(() => resolve(null), 20000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const w = img.naturalWidth || 1024;
        const h = img.naturalHeight || 512;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }

        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, w, h).data;

        // Convert to coverage Float32Array (360×180)
        // Greyscale image: R=G=B, brightness = cloud coverage
        const coverage = new Float32Array(GRID_W * GRID_H);

        for (let j = 0; j < GRID_H; j++) {
          for (let i = 0; i < GRID_W; i++) {
            const px = Math.floor((i / GRID_W) * w);
            const py = Math.floor((j / GRID_H) * h);
            const idx = (py * w + px) * 4;

            const r = pixels[idx], g = pixels[idx+1], b = pixels[idx+2], a = pixels[idx+3];

            if (a < 10) { coverage[j * GRID_W + i] = 0; continue; }

            // Greyscale: brightness = cloud coverage
            // Bright = cloudy, Dark = clear
            const brightness = (r + g + b) / (3 * 255);

            coverage[j * GRID_W + i] = brightness;
          }
        }

        resolve(coverage);
      } catch (e) {
        console.warn('[LiveCloud] Canvas extraction failed:', e);
        resolve(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };

    img.src = CLOUD_MAP_URL;
  });
}

// ── Blending ───────────────────────────────────────────────────────────

/**
 * EVE: "layer satellite maps with noise, set the minimum value of the noise
 * to be a middle value instead of 0 so it doesn't eat your cloud map"
 */
function blendWithNoise(satellite: Float32Array, noise: Float32Array): Float32Array {
  const result = new Float32Array(satellite.length);
  for (let i = 0; i < satellite.length; i++) {
    const sat = satellite[i];
    if (sat < 0.05) {
      // Clear sky stays clear — noise can't create clouds
      result[i] = sat * 0.8;
    } else {
      // Cloudy: satellite shape + noise texture
      result[i] = sat * (1 - NOISE_BLEND) + noise[i] * NOISE_BLEND * sat;
    }
  }
  return result;
}

// ── Main Class ─────────────────────────────────────────────────────────

export class LiveCloudMap {
  private current: CoverageMap | null = null;
  private noise: Float32Array | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLoading = false;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor() {
    // Pre-generate noise, re-seed hourly for subtle variation
    this.noise = generateNoise(GRID_W, GRID_H, Math.floor(Date.now() / 3600000));
  }

  getCoverage(): CoverageMap | null { return this.current; }

  startAutoRefresh(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL);
    console.log('[LiveCloud] Auto-refresh started (3-hour interval)');
  }

  stopAutoRefresh(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async refresh(): Promise<CoverageMap | null> {
    if (this.isLoading) return this.current;
    this.isLoading = true;
    console.log('[LiveCloud] Fetching live cloud map...');

    const raw = await fetchCloudMap();
    if (!raw) {
      console.warn('[LiveCloud] Fetch failed');
      this.isLoading = false;
      return this.current;
    }

    // Regenerate noise with current hour seed
    this.noise = generateNoise(GRID_W, GRID_H, Math.floor(Date.now() / 3600000));

    // Blend satellite map with noise
    const coverage = blendWithNoise(raw, this.noise);

    // Check data quality
    let sum = 0, max = 0, nonZero = 0;
    for (let i = 0; i < coverage.length; i++) {
      sum += coverage[i];
      if (coverage[i] > max) max = coverage[i];
      if (coverage[i] > 0.05) nonZero++;
    }

    this.current = {
      data: coverage,
      width: GRID_W,
      height: GRID_H,
      timestamp: Date.now(),
      source: 'EUMETSAT (live-cloud-maps)',
    };

    this.isLoading = false;
    this.emit('coverageUpdated', this.current);

    console.log(
      `[LiveCloud] ✅ Coverage updated: avg=${(sum/coverage.length).toFixed(3)} ` +
      `max=${max.toFixed(3)} nonZero=${nonZero}/${coverage.length}`
    );

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
