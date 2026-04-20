/**
 * NASAPower — Cloud optical depth from NASA POWER API.
 *
 * Free, no API key, CORS-enabled. CERES SYN1deg data (~1° resolution).
 * Provides CLOUD_OD (cloud optical depth) — hourly resolution only.
 *
 * Does NOT provide per-layer cloud fractions (CLDLOW/CLDMID/CLDHIGH are
 * daily-only and not used). Use the GFS backend for layer data.
 *
 * Docs: https://power.larc.nasa.gov/docs/services/api/
 */

const API_BASE = 'https://power.larc.nasa.gov/api/temporal/hourly/point';

const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface POWEROpticalDepthResult {
  width: number;
  height: number;
  opticalDepth: Float32Array;
  source: 'NASA POWER';
}

interface PointSample {
  lat: number;
  lon: number;
  cloudOd: number;
}

let cache: { timestamp: number; data: POWEROpticalDepthResult } | null = null;

/**
 * Fetch cloud optical depth from NASA POWER for a sparse grid of points.
 * Returns interpolated grid of CLOUD_OD values.
 */
export async function fetchNASAPowerOpticalDepth(): Promise<POWEROpticalDepthResult | null> {
  if (cache && Date.now() - cache.timestamp < CACHE_MS) {
    return cache.data;
  }

  try {
    const latStep = 30;
    const lonStep = 30;
    const lats: number[] = [];
    const lons: number[] = [];

    for (let lat = -90; lat <= 90; lat += latStep) lats.push(lat);
    for (let lon = -180; lon < 180; lon += lonStep) lons.push(lon);

    console.log(`[NASAPower] Fetching CLOUD_OD ${lats.length}x${lons.length} grid...`);

    const samples: PointSample[] = [];
    const batchSize = 6;
    const points: Array<{ lat: number; lon: number }> = [];
    for (const lat of lats) {
      for (const lon of lons) {
        points.push({ lat, lon });
      }
    }

    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(p => fetchPointOd(p.lat, p.lon))
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && (results[j] as PromiseFulfilledResult<PointSample | null>).value) {
          samples.push((results[j] as PromiseFulfilledResult<PointSample>).value);
        }
      }

      if (i + batchSize < points.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[NASAPower] Got ${samples.length}/${points.length} CLOUD_OD points`);

    if (samples.length < 4) {
      console.warn('[NASAPower] Too few CLOUD_OD points');
      return null;
    }

    const data = interpolateToGrid(samples, lats, lons, 360, 180);
    cache = { timestamp: Date.now(), data };
    return data;
  } catch (e) {
    console.warn('[NASAPower] CLOUD_OD fetch failed:', e);
    return null;
  }
}

/**
 * Fetch CLOUD_OD for a single point.
 */
async function fetchPointOd(lat: number, lon: number): Promise<PointSample | null> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

  const params = new URLSearchParams({
    parameters: 'CLOUD_OD',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    start: dateStr,
    end: dateStr,
    format: 'JSON',
  });

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const cloudOd = data?.properties?.parameter?.CLOUD_OD;
    if (!cloudOd) return null;

    const getLatest = (obj: any): number => {
      if (!obj) return 0;
      const keys = Object.keys(obj).sort();
      return obj[keys[keys.length - 1]] ?? 0;
    };

    return { lat, lon, cloudOd: getLatest(cloudOd) };
  } catch {
    return null;
  }
}

/**
 * Interpolate sparse CLOUD_OD samples to regular grid.
 */
function interpolateToGrid(
  samples: PointSample[],
  sampleLats: number[],
  sampleLons: number[],
  width: number,
  height: number
): POWEROpticalDepthResult {
  const opticalDepth = new Float32Array(width * height);

  const latStep = sampleLats[1] - sampleLats[0];
  const lonStep = sampleLons[1] - sampleLons[0];

  const sampleMap = new Map<string, PointSample>();
  for (const s of samples) {
    const latIdx = Math.round((s.lat - sampleLats[0]) / latStep);
    const lonIdx = Math.round((s.lon - sampleLons[0]) / lonStep);
    sampleMap.set(`${latIdx},${lonIdx}`, s);
  }

  for (let j = 0; j < height; j++) {
    const targetLat = 90 - (j / height) * 180;
    for (let i = 0; i < width; i++) {
      const targetLon = (i / width) * 360 - 180;

      const latFrac = (targetLat - sampleLats[0]) / latStep;
      const lonFrac = (targetLon - sampleLons[0]) / lonStep;

      const latIdx0 = Math.max(0, Math.min(sampleLats.length - 1, Math.floor(latFrac)));
      const lonIdx0 = Math.max(0, Math.min(sampleLons.length - 1, Math.floor(lonFrac)));
      const latIdx1 = Math.min(sampleLats.length - 1, latIdx0 + 1);
      const lonIdx1 = Math.min(sampleLons.length - 1, lonIdx0 + 1);

      const latT = Math.max(0, Math.min(1, latFrac - latIdx0));
      const lonT = Math.max(0, Math.min(1, lonFrac - lonIdx0));

      const s00 = sampleMap.get(`${latIdx0},${lonIdx0}`);
      const s01 = sampleMap.get(`${latIdx0},${lonIdx1}`);
      const s10 = sampleMap.get(`${latIdx1},${lonIdx0}`);
      const s11 = sampleMap.get(`${latIdx1},${lonIdx1}`);

      const idx = j * width + i;

      if (s00 && s01 && s10 && s11) {
        const bl = (a: number, b: number, c: number, d: number) =>
          (a * (1 - lonT) + b * lonT) * (1 - latT) + (c * (1 - lonT) + d * lonT) * latT;
        opticalDepth[idx] = bl(s00.cloudOd, s01.cloudOd, s10.cloudOd, s11.cloudOd);
      } else {
        const nearest = s00 || s01 || s10 || s11;
        if (nearest) {
          opticalDepth[idx] = nearest.cloudOd;
        }
      }
    }
  }

  return { width, height, opticalDepth, source: 'NASA POWER' };
}
