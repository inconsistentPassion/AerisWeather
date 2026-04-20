/**
 * GFS (Global Forecast System) data source adapter.
 *
 * Fetches real cloud layer data from NOAA via AWS S3 (noaa-gfs-bdp-pds).
 * Parses GRIB2 with wgrib2 CLI to extract:
 *   - LCDC: Low Cloud Cover (%)
 *   - MCDC: Medium Cloud Cover (%)
 *   - HCDC: High Cloud Cover (%)
 *   - UGRD/VGRD at pressure levels for wind per layer
 *
 * For the /weather/clouds endpoint, also extracts pressure-level variables:
 *   - TCDC (3D cloud fraction at pressure levels)
 *   - CLWMR (cloud liquid water mixing ratio)
 *   - CIWMR (cloud ice water mixing ratio)
 *   - TMP (temperature profile)
 *   - UGRD/VGRD (wind for advection)
 *
 * Falls back to procedural generation if wgrib2 is unavailable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface GFSCycle {
  date: string;  // YYYYMMDD
  hour: string;  // 00, 06, 12, 18
}

export interface CloudLayerGrid {
  width: number;
  height: number;
  data: Float32Array;
}

export interface GFSCloudLayers {
  cycle: GFSCycle;
  forecastHour: number;
  low: CloudLayerGrid;     // LCDC
  medium: CloudLayerGrid;  // MCDC
  high: CloudLayerGrid;    // HCDC
  windU: Float32Array;     // UGRD at representative level per cell
  windV: Float32Array;     // VGRD at representative level per cell
}

/** Pressure-level point extraction for /weather/clouds */
export interface GFSPointCloudData {
  source: 'GFS';
  time: string;
  cycle: GFSCycle;
  forecastHour: number;
  levels: number[];          // pressure in hPa
  cloud_fraction: number[];  // per level (0-1)
  cloud_water: number[];     // CLWMR per level (kg/kg)
  cloud_ice: number[];       // CIWMR per level (kg/kg)
  temperature: number[];     // TMP per level (K)
  wind_u: number[];          // UGRD per level (m/s)
  wind_v: number[];          // VGRD per level (m/s)
  optical_depth: number | null;
  confidence: 'high' | 'medium' | 'low';
  debug?: Record<string, unknown>;
}

/** Pressure levels to extract for point queries */
const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];

const CACHE_DIR = path.join(process.cwd(), 'cache', 'gfs');
const CACHE_TTL = 3600; // 1 hour

// GFS 0.25° grid dimensions
const GFS_WIDTH = 1440;
const GFS_HEIGHT = 721;

let wgrib2Available: boolean | null = null;

// ── wgrib2 detection ──────────────────────────────────────────────────

function checkWgrib2(): boolean {
  if (wgrib2Available !== null) return wgrib2Available;
  try {
    execSync('which wgrib2', { stdio: 'ignore', timeout: 3000 });
    wgrib2Available = true;
    console.log('[GFS] wgrib2 found');
  } catch {
    wgrib2Available = false;
    console.log('[GFS] wgrib2 not found — will use procedural fallback');
  }
  return wgrib2Available;
}

// ── Cycle detection ───────────────────────────────────────────────────

export function getCurrentCycle(): GFSCycle {
  const now = new Date();
  const hours = now.getUTCHours();
  let cycleHour = Math.floor((hours - 4) / 6) * 6;
  let date = new Date(now);

  if (cycleHour < 0) {
    cycleHour = 18;
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return {
    date: date.toISOString().slice(0, 10).replace(/-/g, ''),
    hour: String(cycleHour).padStart(2, '0'),
  };
}

// ── AWS S3 URL ────────────────────────────────────────────────────────

function buildS3Url(cycle: GFSCycle, fhour: number): string {
  const fhh = String(fhour).padStart(3, '0');
  return `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${cycle.date}/${cycle.hour}/atmos/gfs.t${cycle.hour}z.pgrb2.0p25.f${fhh}`;
}

// ── GRIB2 download ────────────────────────────────────────────────────

async function downloadGrib2(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'AerisWeather/0.1.0' },
    });
    if (!res.ok) {
      console.warn(`[GFS] HTTP ${res.status} for ${url}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    console.warn(`[GFS] Download failed: ${(err as Error).message}`);
    return false;
  }
}

// ── wgrib2 parsing ────────────────────────────────────────────────────

interface GribField {
  name: string;
  level: string;
  data: Float32Array;
}

function parseWgrib2Csv(output: string, width: number, height: number): Float32Array {
  // wgrib2 -csv outputs: inventory_num,date,var,level,forecast,value,lon,lat
  const grid = new Float32Array(width * height);
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 8) continue;

    const value = parseFloat(parts[5]);
    const lon = parseFloat(parts[6]);
    const lat = parseFloat(parts[7]);

    if (isNaN(value) || isNaN(lon) || isNaN(lat)) continue;

    // Map lon/lat to grid indices
    const x = Math.floor(((lon + 180) / 360) * width) % width;
    const y = Math.floor(((90 - lat) / 180) * height);

    if (x >= 0 && x < width && y >= 0 && y < height) {
      grid[y * width + x] = value;
    }
  }

  return grid;
}

function extractField(grib2Path: string, variable: string, level: string): Float32Array | null {
  try {
    const cmd = `wgrib2 "${grib2Path}" -s | grep '${variable}' | grep '${level}' | wgrib2 -i "${grib2Path}" -csv /dev/stdout 2>/dev/null`;
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (!output || output.trim().length === 0) return null;
    return parseWgrib2Csv(output, GFS_WIDTH, GFS_HEIGHT);
  } catch {
    return null;
  }
}

// ── Main fetch function ───────────────────────────────────────────────

export async function fetchGFSData(cycle: GFSCycle, fhour: number): Promise<GFSCloudLayers | null> {
  if (!checkWgrib2()) return null;

  // Check cache
  const cacheFile = path.join(CACHE_DIR, `${cycle.date}_${cycle.hour}_f${String(fhour).padStart(3, '0')}.grib2`);
  const cacheJson = cacheFile + '.json';

  // Check if cached JSON is fresh
  if (fs.existsSync(cacheJson)) {
    try {
      const stat = fs.statSync(cacheJson);
      if ((Date.now() - stat.mtimeMs) / 1000 < CACHE_TTL) {
        const raw = JSON.parse(fs.readFileSync(cacheJson, 'utf-8'));
        return {
          cycle: raw.cycle,
          forecastHour: raw.forecastHour,
          low: { width: GFS_WIDTH, height: GFS_HEIGHT, data: new Float32Array(raw.low) },
          medium: { width: GFS_WIDTH, height: GFS_HEIGHT, data: new Float32Array(raw.medium) },
          high: { width: GFS_WIDTH, height: GFS_HEIGHT, data: new Float32Array(raw.high) },
          windU: new Float32Array(raw.windU),
          windV: new Float32Array(raw.windV),
        };
      }
    } catch {}
  }

  // Download GRIB2 if not cached
  if (!fs.existsSync(cacheFile)) {
    const url = buildS3Url(cycle, fhour);
    console.log(`[GFS] Downloading: ${url}`);
    const ok = await downloadGrib2(url, cacheFile);
    if (!ok) return null;
  }

  // Parse with wgrib2
  console.log(`[GFS] Parsing: ${cacheFile}`);
  try {
    const low = extractField(cacheFile, 'LCDC', 'low cloud layer');
    const medium = extractField(cacheFile, 'MCDC', 'middle cloud layer');
    const high = extractField(cacheFile, 'HCDC', 'high cloud layer');
    const windU = extractField(cacheFile, 'UGRD', '850 mb');
    const windV = extractField(cacheFile, 'VGRD', '850 mb');

    if (!low || !medium || !high) {
      console.warn('[GFS] Missing cloud layer fields');
      return null;
    }

    const result: GFSCloudLayers = {
      cycle,
      forecastHour: fhour,
      low: { width: GFS_WIDTH, height: GFS_HEIGHT, data: low },
      medium: { width: GFS_WIDTH, height: GFS_HEIGHT, data: medium },
      high: { width: GFS_WIDTH, height: GFS_HEIGHT, data: high },
      windU: windU ?? new Float32Array(GFS_WIDTH * GFS_HEIGHT),
      windV: windV ?? new Float32Array(GFS_WIDTH * GFS_HEIGHT),
    };

    // Cache as JSON
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheJson, JSON.stringify({
        cycle: result.cycle,
        forecastHour: result.forecastHour,
        low: Array.from(result.low.data),
        medium: Array.from(result.medium.data),
        high: Array.from(result.high.data),
        windU: Array.from(result.windU),
        windV: Array.from(result.windV),
      }), 'utf-8');
    } catch (err) {
      console.warn(`[GFS] Cache write failed: ${(err as Error).message}`);
    }

    // Clean up GRIB2 file (keep JSON)
    try { fs.unlinkSync(cacheFile); } catch {}

    console.log(`[GFS] Parsed cloud layers: low=${low.length}, medium=${medium.length}, high=${high.length}`);
    return result;
  } catch (err) {
    console.warn(`[GFS] wgrib2 parse failed: ${(err as Error).message}`);
    return null;
  }
}

// ── Resample to target grid ───────────────────────────────────────────

export function resampleGrid(source: Float32Array, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
  const result = new Float32Array(dstW * dstH);

  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy / dstH) * srcH;
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(srcH - 1, sy0 + 1);
    const fy = sy - sy0;

    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx / dstW) * srcW;
      const sx0 = Math.floor(sx) % srcW;
      const sx1 = (sx0 + 1) % srcW;
      const fx = sx - Math.floor(sx);

      const v00 = source[sy0 * srcW + sx0] ?? 0;
      const v10 = source[sy0 * srcW + sx1] ?? 0;
      const v01 = source[sy1 * srcW + sx0] ?? 0;
      const v11 = source[sy1 * srcW + sx1] ?? 0;

      result[dy * dstW + dx] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
                                v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  }

  return result;
}

// ── Clean old cache ───────────────────────────────────────────────────

export function cleanCache(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      const fp = path.join(CACHE_DIR, file);
      const stat = fs.statSync(fp);
      if ((now - stat.mtimeMs) / 1000 > CACHE_TTL * 2) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[GFS] Cleaned ${cleaned} cached files`);
  } catch {}
}

// ── Point-level extraction for /weather/clouds ────────────────────────

/**
 * Extract a single variable at a specific pressure level from a GRIB2 file,
 * then bilinear-interpolate to the requested (lat, lon) point.
 * Returns the value at the point, or null if the field is missing.
 */
function extractFieldAtPoint(
  grib2Path: string,
  variable: string,
  pressureHpa: number,
  lat: number,
  lon: number
): number | null {
  try {
    const levelStr = `${pressureHpa} mb`;
    const cmd = `wgrib2 "${grib2Path}" -s | grep '${variable}' | grep '${levelStr}' | wgrib2 -i "${grib2Path}" -csv /dev/stdout 2>/dev/null`;
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 50 * 1024 * 1024,
    });

    if (!output || output.trim().length === 0) return null;

    // Parse CSV to full grid, then bilinear-interpolate to point
    const grid = parseWgrib2Csv(output, GFS_WIDTH, GFS_HEIGHT);
    return bilinearInterpolate(grid, GFS_WIDTH, GFS_HEIGHT, lat, lon);
  } catch {
    return null;
  }
}

/**
 * Bilinear interpolation of a 0.25° GFS grid to an arbitrary (lat, lon) point.
 * Grid layout: rows from 90°N to 90°S, columns from 0°E to 359.75°E.
 */
function bilinearInterpolate(
  grid: Float32Array,
  width: number,
  height: number,
  lat: number,
  lon: number
): number {
  // Map lat/lon to fractional grid indices
  const gx = ((lon + 180) / 360) * width;
  const gy = ((90 - lat) / 180) * height;

  const x0 = Math.floor(gx) % width;
  const x1 = (x0 + 1) % width;
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(gy)));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));

  const fx = gx - Math.floor(gx);
  const fy = gy - Math.floor(gy);

  const v00 = grid[y0 * width + x0] ?? 0;
  const v10 = grid[y0 * width + x1] ?? 0;
  const v01 = grid[y1 * width + x0] ?? 0;
  const v11 = grid[y1 * width + x1] ?? 0;

  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
         v01 * (1 - fx) * fy + v11 * fx * fy;
}

/**
 * Extract cloud-related fields at a single (lat, lon) point across pressure levels.
 *
 * Tries to extract:
 *   - TCDC (Total Cloud Cover) at each pressure level → cloud_fraction
 *   - CLWMR (Cloud Liquid Water Mixing Ratio) → cloud_water (kg/kg)
 *   - CIWMR (Cloud Ice Water Mixing Ratio) → cloud_ice (kg/kg)
 *   - TMP (Temperature) → temperature (K)
 *   - UGRD/VGRD (Wind) → wind_u/wind_v (m/s)
 *
 * If TCDC is not found, falls back to layer-based LCDC/MCDC/HCDC.
 * Missing variables are filled with null-like values.
 */
export async function fetchGFSPointCloud(
  cycle: GFSCycle,
  fhour: number,
  lat: number,
  lon: number,
  debug = false
): Promise<GFSPointCloudData | null> {
  if (!checkWgrib2()) return null;

  // Ensure GRIB2 file exists (download or use cache)
  const grib2Path = path.join(CACHE_DIR, `${cycle.date}_${cycle.hour}_f${String(fhour).padStart(3, '0')}.grib2`);
  const cacheJsonPath = grib2Path + '_point.json';

  // Check point cache
  const pointCacheKey = `${cycle.date}_${cycle.hour}_f${String(fhour).padStart(3, '0')}_${lat.toFixed(2)}_${lon.toFixed(2)}`;
  const pointCacheFile = path.join(CACHE_DIR, `point_${pointCacheKey.replace(/[.\-]/g, '_')}.json`);

  if (fs.existsSync(pointCacheFile)) {
    try {
      const stat = fs.statSync(pointCacheFile);
      if ((Date.now() - stat.mtimeMs) / 1000 < CACHE_TTL) {
        return JSON.parse(fs.readFileSync(pointCacheFile, 'utf-8'));
      }
    } catch {}
  }

  // Download GRIB2 if not cached
  if (!fs.existsSync(grib2Path)) {
    const url = buildS3Url(cycle, fhour);
    console.log(`[GFS] Downloading for point query: ${url}`);
    const ok = await downloadGrib2(url, grib2Path);
    if (!ok) return null;
  }

  const resultTime = new Date();
  resultTime.setUTCHours(parseInt(cycle.hour), 0, 0, 0);
  resultTime.setUTCDate(resultTime.getUTCDate() + Math.floor(fhour / 24));

  const levels: number[] = [];
  const cloud_fraction: number[] = [];
  const cloud_water: number[] = [];
  const cloud_ice: number[] = [];
  const temperature: number[] = [];
  const wind_u: number[] = [];
  const wind_v: number[] = [];
  let hasTcdc = false;
  const debugInfo: Record<string, unknown> = {};

  try {
    // Try TCDC at each pressure level
    for (const plevel of PRESSURE_LEVELS) {
      const cf = extractFieldAtPoint(grib2Path, 'TCDC', plevel, lat, lon);
      if (cf !== null) {
        hasTcdc = true;
        levels.push(plevel);
        cloud_fraction.push(cf / 100); // GFS TCDC is in %
        cloud_water.push(extractFieldAtPoint(grib2Path, 'CLWMR', plevel, lat, lon) ?? 0);
        cloud_ice.push(extractFieldAtPoint(grib2Path, 'CIWMR', plevel, lat, lon) ?? 0);
        temperature.push(extractFieldAtPoint(grib2Path, 'TMP', plevel, lat, lon) ?? 0);
        wind_u.push(extractFieldAtPoint(grib2Path, 'UGRD', plevel, lat, lon) ?? 0);
        wind_v.push(extractFieldAtPoint(grib2Path, 'VGRD', plevel, lat, lon) ?? 0);
      }
    }

    // If TCDC not available, fall back to LCDC/MCDC/HCDC layer fields
    if (!hasTcdc) {
      console.log('[GFS] TCDC not available, using LCDC/MCDC/HCDC layer fields');
      const lcf = extractFieldAtPoint(grib2Path, 'LCDC', 0, lat, lon);
      const mcf = extractFieldAtPoint(grib2Path, 'MCDC', 0, lat, lon);
      const hcf = extractFieldAtPoint(grib2Path, 'HCDC', 0, lat, lon);

      // Map layer fields to representative pressure levels
      const layerMapping = [
        { plevel: 925, cf: lcf },
        { plevel: 850, cf: lcf },
        { plevel: 700, cf: mcf },
        { plevel: 500, cf: mcf },
        { plevel: 300, cf: hcf },
        { plevel: 200, cf: hcf },
      ];

      for (const layer of layerMapping) {
        if (layer.cf !== null) {
          levels.push(layer.plevel);
          cloud_fraction.push(layer.cf / 100);
          cloud_water.push(0);
          cloud_ice.push(0);
          temperature.push(extractFieldAtPoint(grib2Path, 'TMP', layer.plevel, lat, lon) ?? 0);
          wind_u.push(extractFieldAtPoint(grib2Path, 'UGRD', layer.plevel, lat, lon) ?? 0);
          wind_v.push(extractFieldAtPoint(grib2Path, 'VGRD', layer.plevel, lat, lon) ?? 0);
        }
      }

      if (debug) debugInfo.layerFallback = true;
    }

    if (debug) {
      debugInfo.hasTcdc = hasTcdc;
      debugInfo.levelsExtracted = levels.length;
      debugInfo.cycle = cycle;
      debugInfo.forecastHour = fhour;
      debugInfo.requestedPoint = { lat, lon };
    }

    if (levels.length === 0) {
      console.warn('[GFS] No cloud data extracted for point query');
      return null;
    }

    // Compute total optical depth from cloud water/ice profiles (rough estimate)
    // τ ≈ Σ (q_cloud * Δp / g) * k_ext  where k_ext ~ 100 m²/kg (approximate)
    let optical_depth: number | null = null;
    if (hasTcdc && cloud_water.some(v => v > 0)) {
      const G = 9.81;
      const K_EXT_LIQ = 100;  // m²/kg (approximate mass extinction)
      const K_EXT_ICE = 80;
      let tau = 0;
      for (let i = 0; i < levels.length; i++) {
        const dp = i > 0 ? Math.abs(levels[i] - levels[i - 1]) * 100 : 5000; // hPa → Pa
        tau += (cloud_water[i] * K_EXT_LIQ + cloud_ice[i] * K_EXT_ICE) * dp / G;
      }
      optical_depth = tau > 0 ? Math.round(tau * 1000) / 1000 : null;
    }

    const pointData: GFSPointCloudData = {
      source: 'GFS',
      time: `${cycle.date.slice(0, 4)}-${cycle.date.slice(4, 6)}-${cycle.date.slice(6, 8)}T${cycle.hour}:00:00Z`,
      cycle,
      forecastHour: fhour,
      levels,
      cloud_fraction,
      cloud_water,
      cloud_ice,
      temperature,
      wind_u,
      wind_v,
      optical_depth,
      confidence: hasTcdc ? 'high' : 'medium',
    };

    if (debug) pointData.debug = debugInfo;

    // Cache point result
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(pointCacheFile, JSON.stringify(pointData), 'utf-8');
    } catch {}

    return pointData;
  } catch (err) {
    console.warn(`[GFS] Point extraction failed: ${(err as Error).message}`);
    return null;
  }
}

// Run cleanup every 30 minutes
setInterval(cleanCache, 30 * 60 * 1000);
