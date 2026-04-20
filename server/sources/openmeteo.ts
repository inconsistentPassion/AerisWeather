/**
 * Open-Meteo server-side source — hourly cloud layers.
 *
 * Provides cloudcover, cloudcover_low, cloudcover_mid, cloudcover_high
 * from GFS model at hourly resolution. No API key, CORS-enabled.
 *
 * Used as fallback when GFS GRIB2 parsing fails.
 *
 * Docs: https://open-meteo.com/en/docs
 */

const API_BASE = 'https://api.open-meteo.com/v1/forecast';

export interface OpenMeteoCloudLayers {
  source: 'Open-Meteo';
  time: string;
  width: number;
  height: number;
  cloudFraction: Float32Array;  // total cloud cover (0-1)
  low: Float32Array;            // cloudcover_low (0-1)
  medium: Float32Array;         // cloudcover_mid (0-1)
  high: Float32Array;           // cloudcover_high (0-1)
  windU: Float32Array;
  windV: Float32Array;
}

interface SamplePoint {
  lat: number;
  lon: number;
  cloudCover: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  windSpeed: number;
  windDir: number;
}

const MAX_PER_CALL = 25;

/**
 * Fetch cloud layers from Open-Meteo for a grid.
 * Samples at `sampleStep` degree intervals, then interpolates to target grid.
 */
export async function fetchOpenMeteoCloudLayers(
  targetWidth: number = 360,
  targetHeight: number = 180,
  sampleStep: number = 30
): Promise<OpenMeteoCloudLayers | null> {
  const lats: number[] = [];
  const lons: number[] = [];
  for (let lat = -90; lat <= 90; lat += sampleStep) lats.push(lat);
  for (let lon = -180; lon < 180; lon += sampleStep) lons.push(lon);

  const points: SamplePoint[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      points.push({ lat, lon, cloudCover: 0, cloudLow: 0, cloudMid: 0, cloudHigh: 0, windSpeed: 0, windDir: 0 });
    }
  }

  console.log(`[OpenMeteo-Server] Fetching ${points.length} points, ${Math.ceil(points.length / MAX_PER_CALL)} batches`);

  const allData: SamplePoint[] = [];

  for (let i = 0; i < points.length; i += MAX_PER_CALL) {
    const batch = points.slice(i, i + MAX_PER_CALL);
    const batchData = await fetchBatch(batch);

    if (batchData) {
      allData.push(...batchData);
    } else {
      console.warn(`[OpenMeteo-Server] Batch ${Math.floor(i / MAX_PER_CALL) + 1} failed`);
      break;
    }

    if (i + MAX_PER_CALL < points.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (allData.length < 4) {
    console.warn('[OpenMeteo-Server] Too few points');
    return null;
  }

  console.log(`[OpenMeteo-Server] Got ${allData.length} points, interpolating to ${targetWidth}x${targetHeight}`);

  return interpolateToGrid(allData, lats, lons, targetWidth, targetHeight);
}

/**
 * Fetch a batch of points from Open-Meteo.
 * Uses GFS model for hourly cloudcover_low/mid/high.
 */
async function fetchBatch(points: SamplePoint[]): Promise<SamplePoint[] | null> {
  const lats = points.map(p => p.lat).join(',');
  const lons = points.map(p => p.lon).join(',');

  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    hourly: 'cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high',
    current: 'wind_speed_10m,wind_direction_10m',
    models: 'gfs',
    wind_speed_unit: 'ms',
    forecast_days: '1',
    timezone: 'GMT',
  });

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'AerisWeather/0.1.0' },
    });

    if (!res.ok) {
      console.warn(`[OpenMeteo-Server] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const results: SamplePoint[] = [];

    if (Array.isArray(data)) {
      for (let i = 0; i < data.length && i < points.length; i++) {
        const d = data[i];
        const hourly = d.hourly;
        const current = d.current;

        if (!hourly) continue;

        // Get latest hour index
        const lastIdx = (hourly.time?.length ?? 1) - 1;

        results.push({
          lat: points[i].lat,
          lon: points[i].lon,
          cloudCover: (hourly.cloudcover?.[lastIdx] ?? 0) / 100,
          cloudLow: (hourly.cloudcover_low?.[lastIdx] ?? 0) / 100,
          cloudMid: (hourly.cloudcover_mid?.[lastIdx] ?? 0) / 100,
          cloudHigh: (hourly.cloudcover_high?.[lastIdx] ?? 0) / 100,
          windSpeed: current?.wind_speed_10m ?? 0,
          windDir: current?.wind_direction_10m ?? 0,
        });
      }
    }

    return results.length > 0 ? results : null;
  } catch (err) {
    console.warn(`[OpenMeteo-Server] Fetch error: ${(err as Error).message}`);
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
): OpenMeteoCloudLayers {
  const cloudFraction = new Float32Array(width * height);
  const low = new Float32Array(width * height);
  const medium = new Float32Array(width * height);
  const high = new Float32Array(width * height);
  const windU = new Float32Array(width * height);
  const windV = new Float32Array(width * height);

  const latStep = sampleLats[1] - sampleLats[0];
  const lonStep = sampleLons[1] - sampleLons[0];

  const sampleMap = new Map<string, SamplePoint>();
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

        cloudFraction[idx] = bl(s00.cloudCover, s01.cloudCover, s10.cloudCover, s11.cloudCover);
        low[idx] = bl(s00.cloudLow, s01.cloudLow, s10.cloudLow, s11.cloudLow);
        medium[idx] = bl(s00.cloudMid, s01.cloudMid, s10.cloudMid, s11.cloudMid);
        high[idx] = bl(s00.cloudHigh, s01.cloudHigh, s10.cloudHigh, s11.cloudHigh);

        const w00 = windToUV(s00.windSpeed, s00.windDir);
        const w01 = windToUV(s01.windSpeed, s01.windDir);
        const w10 = windToUV(s10.windSpeed, s10.windDir);
        const w11 = windToUV(s11.windSpeed, s11.windDir);
        windU[idx] = bl(w00.u, w01.u, w10.u, w11.u);
        windV[idx] = bl(w00.v, w01.v, w10.v, w11.v);
      } else {
        const nearest = s00 || s01 || s10 || s11;
        if (nearest) {
          cloudFraction[idx] = nearest.cloudCover;
          low[idx] = nearest.cloudLow;
          medium[idx] = nearest.cloudMid;
          high[idx] = nearest.cloudHigh;
          const w = windToUV(nearest.windSpeed, nearest.windDir);
          windU[idx] = w.u;
          windV[idx] = w.v;
        }
      }
    }
  }

  return {
    source: 'Open-Meteo',
    time: new Date().toISOString(),
    width,
    height,
    cloudFraction,
    low,
    medium,
    high,
    windU,
    windV,
  };
}

function windToUV(speed: number, dirDeg: number): { u: number; v: number } {
  const dirRad = (dirDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(dirRad), v: -speed * Math.cos(dirRad) };
}
