/**
 * NASA POWER data source adapter — fallback cloud data.
 *
 * Endpoints (no API key required):
 *   Daily:   CLDLOW, CLDMID, CLDHIGH  → low/mid/high cloud fraction
 *   Hourly:  CLOUD_OD                 → cloud optical depth (CERES SYN1deg, ~1°)
 *
 * Constraints:
 *   - CLDLOW/CLDMID/CLDHIGH are only available at daily resolution.
 *   - CLOUD_OD is available hourly via CERES SYN1deg.
 *   - POWER rejects future dates (returns 422).
 *   - Native resolution is ~1° (we interpolate to requested point).
 *
 * Docs: https://power.larc.nasa.gov/docs/services/api/
 */

import * as fs from 'fs';
import * as path from 'path';

const DAILY_BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const HOURLY_BASE = 'https://power.larc.nasa.gov/api/temporal/hourly/point';

const CACHE_DIR = path.join(process.cwd(), 'cache', 'power');
const CACHE_TTL = 3600; // 1 hour

export interface POWERCloudData {
  source: 'POWER';
  time: string;
  levels: string[];              // ["low", "mid", "high"]
  cloud_fraction: number[];      // per level (0-1)
  cloud_water: null;
  cloud_ice: null;
  optical_depth: number | null;  // CLOUD_OD
  confidence: 'medium' | 'low';
  spatial_resolution: string;    // "~1° (CERES SYN1deg)"
  interpolation: string;         // "nearest-neighbor"
  debug?: Record<string, unknown>;
}

/**
 * Fetch daily low/mid/high cloud fractions from NASA POWER.
 */
async function fetchDailyCloudFractions(
  lat: number,
  lon: number,
  dateStr: string // YYYYMMDD
): Promise<{ cldLow: number; cldMid: number; cldHigh: number } | null> {
  const params = new URLSearchParams({
    parameters: 'CLDLOW,CLDMID,CLDHIGH',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    start: dateStr,
    end: dateStr,
    format: 'JSON',
  });

  const url = `${DAILY_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'AerisWeather/0.1.0' },
    });

    if (res.status === 422) {
      console.warn('[POWER] Daily request rejected (422) — likely future date');
      return null;
    }

    if (!res.ok) {
      console.warn(`[POWER] Daily HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const params = data?.properties?.parameter;
    if (!params) return null;

    const getVal = (obj: any): number => {
      if (!obj) return 0;
      const val = obj[dateStr];
      return typeof val === 'number' ? val / 100 : 0; // % → fraction
    };

    return {
      cldLow: getVal(params.CLDLOW),
      cldMid: getVal(params.CLDMID),
      cldHigh: getVal(params.CLDHIGH),
    };
  } catch (err) {
    console.warn(`[POWER] Daily fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch hourly cloud optical depth from NASA POWER (CERES SYN1deg).
 */
async function fetchHourlyOpticalDepth(
  lat: number,
  lon: number,
  dateStr: string, // YYYYMMDD
  hour: number     // 0-23
): Promise<number | null> {
  const params = new URLSearchParams({
    parameters: 'CLOUD_OD',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    start: dateStr,
    end: dateStr,
    format: 'JSON',
  });

  const url = `${HOURLY_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'AerisWeather/0.1.0' },
    });

    if (res.status === 422) {
      console.warn('[POWER] Hourly request rejected (422) — likely future date');
      return null;
    }

    if (!res.ok) {
      console.warn(`[POWER] Hourly HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const cloudOd = data?.properties?.parameter?.CLOUD_OD;
    if (!cloudOd) return null;

    // POWER hourly keys: "YYYYMMDDHH" (e.g., "2026042003")
    const hourKey = `${dateStr}${String(hour).padStart(2, '0')}`;
    const val = cloudOd[hourKey];

    if (typeof val === 'number' && val >= 0) return val;

    // Fallback: try nearest available hour
    const keys = Object.keys(cloudOd).sort();
    if (keys.length > 0) {
      const nearest = keys.reduce((best, k) => {
        const kh = parseInt(k.slice(-2));
        return Math.abs(kh - hour) < Math.abs(parseInt(best.slice(-2)) - hour) ? k : best;
      });
      return cloudOd[nearest] ?? null;
    }

    return null;
  } catch (err) {
    console.warn(`[POWER] Hourly fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build a YYYYMMDD string that is not in the future (POWER rejects future dates).
 */
function safeDateStr(date: Date): string {
  const now = new Date();
  // If requested date is in the future, use today
  const safeDate = date.getTime() > now.getTime() ? now : date;
  return safeDate.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Main fetch function — returns normalized cloud data from NASA POWER.
 */
export async function fetchPOWERCloudData(
  lat: number,
  lon: number,
  isoTime: string,
  debug = false
): Promise<POWERCloudData | null> {
  const requestedDate = new Date(isoTime);
  const dateStr = safeDateStr(requestedDate);
  const hour = requestedDate.getUTCHours();

  // Check cache
  const cacheKey = `power_${lat.toFixed(1)}_${lon.toFixed(1)}_${dateStr}_${hour}`;
  const cacheFile = path.join(CACHE_DIR, `${cacheKey.replace(/[.\-]/g, '_')}.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      if ((Date.now() - stat.mtimeMs) / 1000 < CACHE_TTL) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (debug) cached.debug = { ...cached.debug, fromCache: true };
        return cached;
      }
    } catch {}
  }

  console.log(`[POWER] Fetching cloud data for ${lat}, ${lon} @ ${dateStr}h${hour}`);

  // Fetch daily fractions + hourly optical depth in parallel
  const [dailyResult, opticalDepth] = await Promise.all([
    fetchDailyCloudFractions(lat, lon, dateStr),
    fetchHourlyOpticalDepth(lat, lon, dateStr, hour),
  ]);

  if (!dailyResult) {
    console.warn('[POWER] No daily cloud data available');
    return null;
  }

  const isFutureDate = requestedDate.getTime() > Date.now();

  const result: POWERCloudData = {
    source: 'POWER',
    time: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${String(hour).padStart(2, '0')}:00:00Z`,
    levels: ['low', 'mid', 'high'],
    cloud_fraction: [dailyResult.cldLow, dailyResult.cldMid, dailyResult.cldHigh],
    cloud_water: null,
    cloud_ice: null,
    optical_depth: opticalDepth,
    confidence: isFutureDate ? 'low' : 'medium',
    spatial_resolution: '~1° (CERES SYN1deg)',
    interpolation: 'nearest-neighbor',
  };

  if (debug) {
    result.debug = {
      dateStr,
      hour,
      wasFutureDate: isFutureDate,
      dailyUrl: `${DAILY_BASE}?parameters=CLDLOW,CLDMID,CLDHIGH&community=RE&longitude=${lon}&latitude=${lat}&start=${dateStr}&end=${dateStr}&format=JSON`,
      hourlyUrl: `${HOURLY_BASE}?parameters=CLOUD_OD&community=RE&longitude=${lon}&latitude=${lat}&start=${dateStr}&end=${dateStr}&format=JSON`,
      rawDaily: dailyResult,
      rawOpticalDepth: opticalDepth,
    };
  }

  // Cache result
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result), 'utf-8');
  } catch {}

  return result;
}

/**
 * Clean expired POWER cache entries.
 */
export function cleanPOWERCache(): void {
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
    if (cleaned > 0) console.log(`[POWER] Cleaned ${cleaned} cached files`);
  } catch {}
}

setInterval(cleanPOWERCache, 30 * 60 * 1000);
