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

// Run cleanup every 30 minutes
setInterval(cleanCache, 30 * 60 * 1000);
