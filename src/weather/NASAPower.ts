/**
 * NASAPower — Cloud layer data from NASA POWER API.
 *
 * Free, no API key, CORS-enabled. Scientific-grade satellite data.
 * Provides low/mid/high cloud cover fractions — the GFS replacement
 * for when the backend isn't available.
 *
 * Docs: https://power.larc.nasa.gov/docs/services/api/
 */

const API_BASE = 'https://power.larc.nasa.gov/api/temporal/hourly/point';

// Cache duration: 6 hours (NASA POWER updates daily, hourly resolution)
const CACHE_MS = 6 * 60 * 60 * 1000;

interface CachedData {
  timestamp: number;
  data: {
    width: number;
    height: number;
    low: Float32Array;
    medium: Float32Array;
    high: Float32Array;
    windU: Float32Array;
    windV: Float32Array;
    humidity: Float32Array;
    cloudFraction: Float32Array;
  };
}

let cache: CachedData | null = null;

/**
 * Fetch cloud layer data from NASA POWER for a grid of points.
 * Returns 3-layer cloud cover (low/mid/high) + wind + humidity.
 */
export async function fetchNASAPowerCloudLayers(): Promise<{
  width: number;
  height: number;
  low: Float32Array;
  medium: Float32Array;
  high: Float32Array;
  windU: Float32Array;
  windV: Float32Array;
  humidity: Float32Array;
  cloudFraction: Float32Array;
} | null> {
  if (cache && Date.now() - cache.timestamp < CACHE_MS) {
    return cache.data;
  }

  try {
    // Sample grid: 30° step → 7 lat × 12 lon = 84 points
    // NASA POWER supports single-point requests, so we batch a few
    const latStep = 30;
    const lonStep = 30;
    const lats: number[] = [];
    const lons: number[] = [];

    for (let lat = -90; lat <= 90; lat += latStep) lats.push(lat);
    for (let lon = -180; lon < 180; lon += lonStep) lons.push(lon);

    console.log(`[NASAPower] Fetching ${lats.length}x${lons.length} grid...`);

    // Fetch in parallel batches (NASA POWER allows concurrent requests)
    const samples: Array<{
      lat: number; lon: number;
      cldLow: number; cldMid: number; cldHigh: number;
      wind10m: number; windDir10m: number;
      humidity: number; temp: number;
    }> = [];

    const batchSize = 6; // concurrent requests
    const points: Array<{ lat: number; lon: number }> = [];
    for (const lat of lats) {
      for (const lon of lons) {
        points.push({ lat, lon });
      }
    }

    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(p => fetchPoint(p.lat, p.lon))
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && (results[j] as PromiseFulfilledResult<any>).value) {
          samples.push((results[j] as PromiseFulfilledResult<any>).value);
        }
      }

      // Small delay between batches
      if (i + batchSize < points.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[NASAPower] Got ${samples.length}/${points.length} points`);

    if (samples.length < 4) {
      console.warn('[NASAPower] Too few points');
      return null;
    }

    // Interpolate to 360×180 grid
    const grid = interpolateToGrid(samples, lats, lons, 360, 180);
    cache = { timestamp: Date.now(), data: grid };
    return grid;
  } catch (e) {
    console.warn('[NASAPower] Fetch failed:', e);
    return null;
  }
}

/**
 * Fetch a single point from NASA POWER.
 */
async function fetchPoint(lat: number, lon: number): Promise<{
  lat: number; lon: number;
  cldLow: number; cldMid: number; cldHigh: number;
  wind10m: number; windDir10m: number;
  humidity: number; temp: number;
} | null> {
  const now = new Date();
  const startDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const endDate = startDate;

  const params = new URLSearchParams({
    parameters: 'CLDLOW,CLDMID,CLDHIGH,WS10M,WD10M,RH2M,T2M',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    start: startDate,
    end: endDate,
    format: 'JSON',
  });

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Don't warn on individual point failures
      return null;
    }

    const data = await res.json();
    const params_data = data?.properties?.parameter;
    if (!params_data) return null;

    // Get latest hour's values (last entry in the arrays)
    const getLatest = (obj: any): number => {
      if (!obj) return 0;
      const keys = Object.keys(obj).sort();
      return obj[keys[keys.length - 1]] ?? 0;
    };

    return {
      lat, lon,
      cldLow: (getLatest(params_data.CLDLOW) ?? 0) / 100,
      cldMid: (getLatest(params_data.CLDMID) ?? 0) / 100,
      cldHigh: (getLatest(params_data.CLDHIGH) ?? 0) / 100,
      wind10m: getLatest(params_data.WS10M) ?? 0,
      windDir10m: getLatest(params_data.WD10M) ?? 0,
      humidity: getLatest(params_data.RH2M) ?? 50,
      temp: getLatest(params_data.T2M) ?? 15,
    };
  } catch {
    return null;
  }
}

/**
 * Interpolate sparse samples to regular grid.
 */
function interpolateToGrid(
  samples: Array<{
    lat: number; lon: number;
    cldLow: number; cldMid: number; cldHigh: number;
    wind10m: number; windDir10m: number;
    humidity: number; temp: number;
  }>,
  sampleLats: number[],
  sampleLons: number[],
  width: number,
  height: number
): CachedData['data'] {
  const low = new Float32Array(width * height);
  const medium = new Float32Array(width * height);
  const high = new Float32Array(width * height);
  const windU = new Float32Array(width * height);
  const windV = new Float32Array(width * height);
  const humidity = new Float32Array(width * height);
  const cloudFraction = new Float32Array(width * height);

  const latStep = sampleLats[1] - sampleLats[0];
  const lonStep = sampleLons[1] - sampleLons[0];

  const sampleMap = new Map<string, typeof samples[0]>();
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

        low[idx] = bl(s00.cldLow, s01.cldLow, s10.cldLow, s11.cldLow);
        medium[idx] = bl(s00.cldMid, s01.cldMid, s10.cldMid, s11.cldMid);
        high[idx] = bl(s00.cldHigh, s01.cldHigh, s10.cldHigh, s11.cldHigh);
        humidity[idx] = bl(s00.humidity, s01.humidity, s10.humidity, s11.humidity);

        // Wind: convert speed+dir to u/v
        const w00 = windToUV(s00.wind10m, s00.windDir10m);
        const w01 = windToUV(s01.wind10m, s01.windDir10m);
        const w10 = windToUV(s10.wind10m, s10.windDir10m);
        const w11 = windToUV(s11.wind10m, s11.windDir10m);
        windU[idx] = bl(w00.u, w01.u, w10.u, w11.u);
        windV[idx] = bl(w00.v, w01.v, w10.v, w11.v);

        cloudFraction[idx] = Math.max(low[idx], medium[idx], high[idx]);
      } else {
        // Nearest neighbor fallback
        const nearest = s00 || s01 || s10 || s11;
        if (nearest) {
          low[idx] = nearest.cldLow;
          medium[idx] = nearest.cldMid;
          high[idx] = nearest.cldHigh;
          humidity[idx] = nearest.humidity;
          const w = windToUV(nearest.wind10m, nearest.windDir10m);
          windU[idx] = w.u;
          windV[idx] = w.v;
          cloudFraction[idx] = Math.max(nearest.cldLow, nearest.cldMid, nearest.cldHigh);
        }
      }
    }
  }

  return { width, height, low, medium, high, windU, windV, humidity, cloudFraction };
}

function windToUV(speed: number, dirDeg: number): { u: number; v: number } {
  const dirRad = (dirDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(dirRad), v: -speed * Math.cos(dirRad) };
}
