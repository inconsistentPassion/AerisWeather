/**
 * OpenMeteo — Real weather data from Open-Meteo API.
 *
 * Fetches wind (u/v), temperature, cloud cover, and humidity
 * from a global grid of sample points, then interpolates to
 * fill a 360×180 grid for the weather globe.
 *
 * Free, no API key, CORS-enabled.
 */

const API_BASE = 'https://api.open-meteo.com/v1/forecast';

// Grid resolution for sampling (degrees)
// 2.5° = 144×72 = 10368 points → ~42 API calls of 25 points each
const SAMPLE_STEP = 2.5;

// Maximum coordinates per API call
const MAX_PER_CALL = 25;

// Cache duration (15 minutes — Open-Meteo updates hourly)
const CACHE_MS = 15 * 60 * 1000;

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
  // Return cache if fresh
  if (cache && Date.now() - cache.timestamp < CACHE_MS) {
    return cache.grid;
  }

  try {
    // Generate sample grid points
    const lats: number[] = [];
    const lons: number[] = [];

    for (let lat = -80; lat <= 80; lat += SAMPLE_STEP) {
      lats.push(lat);
    }
    for (let lon = -180; lon < 180; lon += SAMPLE_STEP) {
      lons.push(lon);
    }

    // Flatten into coordinate pairs
    const points: Array<{ lat: number; lon: number }> = [];
    for (const lat of lats) {
      for (const lon of lons) {
        points.push({ lat, lon });
      }
    }

    // Fetch in batches
    const allData: Array<{
      lat: number;
      lon: number;
      windSpeed: number;
      windDir: number;
      temp: number;
      humidity: number;
      cloudCover: number;
    }> = [];

    for (let i = 0; i < points.length; i += MAX_PER_CALL) {
      const batch = points.slice(i, i + MAX_PER_CALL);
      const batchData = await fetchBatch(batch);
      if (batchData) {
        allData.push(...batchData);
      }
    }

    if (allData.length === 0) {
      console.warn('[OpenMeteo] No data received');
      return null;
    }

    // Interpolate sparse samples to full 360×180 grid
    const grid = interpolateToGrid(allData, lats, lons, 360, 180);

    cache = { timestamp: Date.now(), grid };
    return grid;
  } catch (e) {
    console.warn('[OpenMeteo] Fetch failed:', e);
    return null;
  }
}

/**
 * Fetch a batch of points from Open-Meteo.
 */
async function fetchBatch(
  points: Array<{ lat: number; lon: number }>
): Promise<Array<{
  lat: number;
  lon: number;
  windSpeed: number;
  windDir: number;
  temp: number;
  humidity: number;
  cloudCover: number;
}> | null> {
  const lats = points.map(p => p.lat).join(',');
  const lons = points.map(p => p.lon).join(',');

  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    current: [
      'wind_speed_10m',
      'wind_direction_10m',
      'temperature_2m',
      'relative_humidity_2m',
      'cloud_cover',
    ].join(','),
    wind_speed_unit: 'ms',
    timezone: 'auto',
  });

  const url = `${API_BASE}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[OpenMeteo] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();

    // Open-Meteo returns arrays when multiple coordinates are provided
    // Handle both single-point (object) and multi-point (array) responses
    const results: Array<{
      lat: number;
      lon: number;
      windSpeed: number;
      windDir: number;
      temp: number;
      humidity: number;
      cloudCover: number;
    }> = [];

    if (Array.isArray(data)) {
      // Multi-point response
      for (let i = 0; i < data.length && i < points.length; i++) {
        const d = data[i];
        const current = d.current;
        if (!current) continue;

        results.push({
          lat: points[i].lat,
          lon: points[i].lon,
          windSpeed: current.wind_speed_10m ?? 0,
          windDir: current.wind_direction_10m ?? 0,
          temp: current.temperature_2m ?? 15,
          humidity: current.relative_humidity_2m ?? 50,
          cloudCover: (current.cloud_cover ?? 0) / 100,
        });
      }
    } else if (data.current) {
      // Single-point response
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
  } catch (e) {
    console.warn('[OpenMeteo] Batch fetch error:', e);
    return null;
  }
}

/**
 * Interpolate sparse weather samples to a regular grid.
 * Uses bilinear interpolation from the nearest 4 sample points.
 */
function interpolateToGrid(
  samples: Array<{
    lat: number;
    lon: number;
    windSpeed: number;
    windDir: number;
    temp: number;
    humidity: number;
    cloudCover: number;
  }>,
  sampleLats: number[],
  sampleLons: number[],
  width: number,
  height: number
): {
  width: number;
  height: number;
  fields: {
    u: Float32Array;
    v: Float32Array;
    temperature: Float32Array;
    humidity: Float32Array;
    cloudFraction: Float32Array;
  };
} {
  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  const temperature = new Float32Array(width * height);
  const humidity = new Float32Array(width * height);
  const cloudFraction = new Float32Array(width * height);

  // Build a lookup from (latIdx, lonIdx) → sample data
  const sampleMap = new Map<string, typeof samples[0]>();
  for (const s of samples) {
    // Snap to nearest grid point
    const latIdx = Math.round((s.lat + 90) / SAMPLE_STEP);
    const lonIdx = Math.round((s.lon + 180) / SAMPLE_STEP);
    sampleMap.set(`${latIdx},${lonIdx}`, s);
  }

  const numLats = sampleLats.length;
  const numLons = sampleLons.length;

  for (let j = 0; j < height; j++) {
    // Target lat: -90 to 90
    const targetLat = 90 - (j / height) * 180;

    for (let i = 0; i < width; i++) {
      // Target lon: -180 to 180
      const targetLon = (i / width) * 360 - 180;

      // Find surrounding sample indices
      const latFrac = (targetLat - sampleLats[0]) / SAMPLE_STEP;
      const lonFrac = (targetLon - sampleLons[0]) / SAMPLE_STEP;

      const latIdx0 = Math.floor(latFrac);
      const lonIdx0 = Math.floor(lonFrac);
      const latIdx1 = Math.min(latIdx0 + 1, numLats - 1);
      const lonIdx1 = Math.min(lonIdx0 + 1, numLons - 1);

      const latT = latFrac - latIdx0;
      const lonT = lonFrac - lonIdx0;

      // Clamp indices
      const li0 = Math.max(0, Math.min(numLats - 1, latIdx0));
      const li1 = Math.max(0, Math.min(numLats - 1, latIdx1));
      const oi0 = Math.max(0, Math.min(numLons - 1, lonIdx0));
      const oi1 = Math.max(0, Math.min(numLons - 1, lonIdx1));

      // Get 4 corner samples
      const s00 = sampleMap.get(`${li0},${oi0}`);
      const s01 = sampleMap.get(`${li0},${oi1}`);
      const s10 = sampleMap.get(`${li1},${oi0}`);
      const s11 = sampleMap.get(`${li1},${oi1}`);

      // Bilinear interpolation
      const idx = j * width + i;

      if (s00 && s01 && s10 && s11) {
        // Convert wind speed + direction to u/v components
        // Wind direction: 0° = N, 90° = E (meteorological convention)
        const w00 = windToUV(s00.windSpeed, s00.windDir);
        const w01 = windToUV(s01.windSpeed, s01.windDir);
        const w10 = windToUV(s10.windSpeed, s10.windDir);
        const w11 = windToUV(s11.windSpeed, s11.windDir);

        u[idx] = bilerp(w00.u, w01.u, w10.u, w11.u, lonT, latT);
        v[idx] = bilerp(w00.v, w01.v, w10.v, w11.v, lonT, latT);
        temperature[idx] = bilerp(s00.temp, s01.temp, s10.temp, s11.temp, lonT, latT);
        humidity[idx] = bilerp(s00.humidity, s01.humidity, s10.humidity, s11.humidity, lonT, latT);
        cloudFraction[idx] = bilerp(s00.cloudCover, s01.cloudCover, s10.cloudCover, s11.cloudCover, lonT, latT);
      } else if (s00) {
        // Fallback to nearest
        const w = windToUV(s00.windSpeed, s00.windDir);
        u[idx] = w.u;
        v[idx] = w.v;
        temperature[idx] = s00.temp;
        humidity[idx] = s00.humidity;
        cloudFraction[idx] = s00.cloudCover;
      }
    }
  }

  return { width, height, fields: { u, v, temperature, humidity, cloudFraction } };
}

/**
 * Convert wind speed (m/s) and direction (degrees, meteorological) to u/v components.
 */
function windToUV(speed: number, dirDeg: number): { u: number; v: number } {
  const dirRad = (dirDeg * Math.PI) / 180;
  // Meteorological direction: where wind comes FROM
  // u = eastward component, v = northward component
  const u = -speed * Math.sin(dirRad);
  const v = -speed * Math.cos(dirRad);
  return { u, v };
}

/**
 * Bilinear interpolation between 4 corner values.
 */
function bilerp(
  v00: number, v01: number,
  v10: number, v11: number,
  tx: number, ty: number
): number {
  const top = v00 * (1 - tx) + v01 * tx;
  const bot = v10 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bot * ty;
}
