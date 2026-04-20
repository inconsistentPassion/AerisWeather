/**
 * OpenMeteo — Real weather data from Open-Meteo API.
 *
 * Multi-resolution approach:
 * 1. INSTANT: Fetch 9 evenly-spaced global points → fill entire grid immediately
 * 2. BACKGROUND: Fetch finer resolution (30° step) over next ~10 seconds
 *
 * Free, no API key, CORS-enabled.
 */

const API_BASE = 'https://api.open-meteo.com/v1/forecast';

const MAX_PER_CALL = 25;
const CACHE_MS = 30 * 60 * 1000;

interface SamplePoint {
  lat: number;
  lon: number;
  windSpeed: number;
  windDir: number;
  temp: number;
  humidity: number;
  cloudCover: number;
}

interface CachedGrid {
  timestamp: number;
  grid: {
    width: number;
    height: number;
    fields: {
      u: Float32Array;
      v: Float32Array;
      temperature: Float32Array;
      humidity: Float32Array;
      cloudFraction: Float32Array;
    };
  };
}

let cache: CachedGrid | null = null;

/**
 * Fetch real global weather grid from Open-Meteo.
 * Returns null if fetch fails.
 */
export async function fetchRealWeatherGrid(): Promise<{
  width: number;
  height: number;
  fields: {
    u: Float32Array;
    v: Float32Array;
    temperature: Float32Array;
    humidity: Float32Array;
    cloudFraction: Float32Array;
  };
} | null> {
  if (cache && Date.now() - cache.timestamp < CACHE_MS) {
    return cache.grid;
  }

  try {
    // STEP 1: Fast fetch — 9 key points (3x3 grid) to get SOMETHING visible immediately
    console.log('[OpenMeteo] Fetching quick global snapshot (9 points)...');
    const quickPoints = generateQuickPoints();
    const quickData = await fetchBatch(quickPoints);

    if (!quickData || quickData.length === 0) {
      console.warn('[OpenMeteo] Quick fetch failed entirely');
      return null;
    }

    console.log(`[OpenMeteo] Quick fetch got ${quickData.length} points — filling grid`);
    const quickGrid = interpolateToGrid(quickData, [90, 0, -90], [-120, 0, 120], 360, 180);
    cache = { timestamp: Date.now(), grid: quickGrid };

    // STEP 2: Background fetch — finer resolution
    fetchBackgroundGrid().then(fineGrid => {
      if (fineGrid) {
        cache = { timestamp: Date.now(), grid: fineGrid };
        // Dispatch custom event so DeckLayers can rebuild
        window.dispatchEvent(new CustomEvent('weather-grid-updated'));
        console.log('[OpenMeteo] Fine grid ready — event dispatched');
      }
    }).catch(e => console.warn('[OpenMeteo] Background fetch error:', e));

    return quickGrid;
  } catch (e) {
    console.warn('[OpenMeteo] Fetch failed:', e);
    return null;
  }
}

/**
 * 9 key points: 3 latitudes × 3 longitudes
 * Covers equator + mid-latitudes in both hemispheres
 */
function generateQuickPoints(): SamplePoint[] {
  const lats = [60, 20, -20, -60];
  const lons = [-120, 0, 120];
  const pts: SamplePoint[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      pts.push({ lat, lon, windSpeed: 0, windDir: 0, temp: 0, humidity: 0, cloudCover: 0 });
    }
  }
  return pts;
}

/**
 * Background: fetch 30° grid (7 lat × 12 lon = 84 points, 4 batches)
 */
async function fetchBackgroundGrid(): Promise<CachedGrid['grid'] | null> {
  const sampleStep = 30;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let lat = -90; lat <= 90; lat += sampleStep) lats.push(lat);
  for (let lon = -180; lon < 180; lon += sampleStep) lons.push(lon);

  const points: SamplePoint[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      points.push({ lat, lon, windSpeed: 0, windDir: 0, temp: 0, humidity: 0, cloudCover: 0 });
    }
  }

  console.log(`[OpenMeteo] Background fetch: ${points.length} points, ${Math.ceil(points.length / MAX_PER_CALL)} batches`);

  const allData: SamplePoint[] = [];
  for (let i = 0; i < points.length; i += MAX_PER_CALL) {
    const batch = points.slice(i, i + MAX_PER_CALL);
    const batchNum = Math.floor(i / MAX_PER_CALL) + 1;

    const batchData = await fetchBatch(batch);
    if (batchData) {
      allData.push(...batchData);
      console.log(`[OpenMeteo] Batch ${batchNum}: ${batchData.length} pts`);
    } else {
      console.warn(`[OpenMeteo] Batch ${batchNum} failed, using partial data (${allData.length} pts so far)`);
      break;
    }

    // 1.5s between batches
    if (i + MAX_PER_CALL < points.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (allData.length < 4) {
    console.warn('[OpenMeteo] Too few points for fine grid');
    return null;
  }

  console.log(`[OpenMeteo] Background complete: ${allData.length}/${points.length} points`);
  return interpolateToGrid(allData, lats, lons, 360, 180);
}

/**
 * Fetch a batch of points from Open-Meteo.
 * Handles CORS, retries, and both array/object response formats.
 */
async function fetchBatch(
  points: SamplePoint[]
): Promise<SamplePoint[] | null> {
  const lats = points.map(p => p.lat).join(',');
  const lons = points.map(p => p.lon).join(',');

  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    current: 'wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m,cloud_cover',
    wind_speed_unit: 'ms',
    timezone: 'GMT',
  });

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[OpenMeteo] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const results: SamplePoint[] = [];

    if (Array.isArray(data)) {
      for (let i = 0; i < data.length && i < points.length; i++) {
        const d = data[i];
        const c = d.current;
        if (!c) continue;
        results.push({
          lat: points[i].lat,
          lon: points[i].lon,
          windSpeed: c.wind_speed_10m ?? 0,
          windDir: c.wind_direction_10m ?? 0,
          temp: c.temperature_2m ?? 15,
          humidity: c.relative_humidity_2m ?? 50,
          cloudCover: (c.cloud_cover ?? 0) / 100,
        });
      }
    } else if (data?.current) {
      results.push({
        lat: points[0].lat,
        lon: points[0].lon,
        windSpeed: data.current.wind_speed_10m ?? 0,
        windDir: data.current.wind_direction_10m ?? 0,
        temp: data.current.temperature_2m ?? 15,
        humidity: data.current.relative_humidity_2m ?? 50,
        cloudCover: (data.current.cloud_cover ?? 0) / 100,
      });
    }

    return results;
  } catch (e: any) {
    console.warn('[OpenMeteo] Fetch error:', e?.message || e);
    return null;
  }
}

/**
 * Interpolate sparse samples to regular grid.
 */
function interpolateToGrid(
  samples: SamplePoint[],
  sampleLats: number[],
  sampleLons: number[],
  width: number,
  height: number
): CachedGrid['grid'] {
  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  const temperature = new Float32Array(width * height);
  const humidity = new Float32Array(width * height);
  const cloudFraction = new Float32Array(width * height);

  const sampleMap = new Map<string, SamplePoint>();
  for (const s of samples) {
    const latIdx = Math.round((s.lat + 90) / (sampleLats[1] - sampleLats[0]));
    const lonIdx = Math.round((s.lon + 180) / (sampleLons[1] - sampleLons[0]));
    sampleMap.set(`${latIdx},${lonIdx}`, s);
  }

  const latStep = sampleLats[1] - sampleLats[0];
  const lonStep = sampleLons[1] - sampleLons[0];
  const numLats = sampleLats.length;
  const numLons = sampleLons.length;

  for (let j = 0; j < height; j++) {
    const targetLat = 90 - (j / height) * 180;
    for (let i = 0; i < width; i++) {
      const targetLon = (i / width) * 360 - 180;

      const latFrac = (targetLat - sampleLats[0]) / latStep;
      const lonFrac = (targetLon - sampleLons[0]) / lonStep;

      const latIdx0 = Math.floor(latFrac);
      const lonIdx0 = Math.floor(lonFrac);
      const latIdx1 = Math.min(latIdx0 + 1, numLats - 1);
      const lonIdx1 = Math.min(lonIdx0 + 1, numLons - 1);

      const latT = Math.max(0, Math.min(1, latFrac - latIdx0));
      const lonT = Math.max(0, Math.min(1, lonFrac - lonIdx0));

      const li0 = Math.max(0, Math.min(numLats - 1, latIdx0));
      const li1 = Math.max(0, Math.min(numLats - 1, latIdx1));
      const oi0 = Math.max(0, Math.min(numLons - 1, lonIdx0));
      const oi1 = Math.max(0, Math.min(numLons - 1, lonIdx1));

      const s00 = sampleMap.get(`${li0},${oi0}`);
      const s01 = sampleMap.get(`${li0},${oi1}`);
      const s10 = sampleMap.get(`${li1},${oi0}`);
      const s11 = sampleMap.get(`${li1},${oi1}`);

      const idx = j * width + i;

      if (s00 && s01 && s10 && s11) {
        const w00 = windToUV(s00.windSpeed, s00.windDir);
        const w01 = windToUV(s01.windSpeed, s01.windDir);
        const w10 = windToUV(s10.windSpeed, s10.windDir);
        const w11 = windToUV(s11.windSpeed, s11.windDir);

        u[idx] = bilerp(w00.u, w01.u, w10.u, w11.u, lonT, latT);
        v[idx] = bilerp(w00.v, w01.v, w10.v, w11.v, lonT, latT);
        temperature[idx] = bilerp(s00.temp, s01.temp, s10.temp, s11.temp, lonT, latT);
        humidity[idx] = bilerp(s00.humidity, s01.humidity, s10.humidity, s11.humidity, lonT, latT);
        cloudFraction[idx] = bilerp(s00.cloudCover, s01.cloudCover, s10.cloudCover, s11.cloudCover, lonT, latT);
      } else {
        // Nearest-neighbor fallback
        const nearest = s00 || s01 || s10 || s11;
        if (nearest) {
          const w = windToUV(nearest.windSpeed, nearest.windDir);
          u[idx] = w.u;
          v[idx] = w.v;
          temperature[idx] = nearest.temp;
          humidity[idx] = nearest.humidity;
          cloudFraction[idx] = nearest.cloudCover;
        }
      }
    }
  }

  return { width, height, fields: { u, v, temperature, humidity, cloudFraction } };
}

function windToUV(speed: number, dirDeg: number): { u: number; v: number } {
  const dirRad = (dirDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(dirRad), v: -speed * Math.cos(dirRad) };
}

function bilerp(v00: number, v01: number, v10: number, v11: number, tx: number, ty: number): number {
  return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
}
