/**
 * Grid — Weather grid normalization and procedural generation.
 */

import type { WeatherGrid } from '../../src/weather/types';

/**
 * Generate a single-level weather grid (backward compatible).
 */
export function generateWeatherGrid(
  level: string,
  time: string,
  width: number,
  height: number
): WeatherGrid & { level: string; timestamp: string } {
  const timeDate = new Date(time);
  const hourOfDay = timeDate.getUTCHours();
  const dayOfYear = Math.floor(
    (timeDate.getTime() - new Date(timeDate.getUTCFullYear(), 0, 0).getTime()) / 86400000
  );

  const cloudFraction = new Float32Array(width * height);
  const humidity = new Float32Array(width * height);
  const temperature = new Float32Array(width * height);
  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  const w = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const lon = (x / width) * 360 - 180;
      const lat = (y / height) * 180 - 90;
      const latRad = (lat * Math.PI) / 180;
      const lonRad = (lon * Math.PI) / 180;

      // Temperature
      const baseTemp = 15 - Math.abs(lat) * 0.6;
      const diurnal = Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2) * 5;
      const seasonal = Math.sin(((dayOfYear - 80) / 365) * Math.PI * 2) * 10 * Math.cos(latRad);
      temperature[idx] = baseTemp + diurnal + seasonal + noise2D(lon, lat, 0.01) * 3;

      // Cloud coverage
      const itcz = Math.exp(-lat * lat * 0.003) * 0.5;
      const storm30 = Math.exp(-Math.pow(Math.abs(lat) - 45, 2) * 0.005) * 0.4;
      const storm60 = Math.exp(-Math.pow(Math.abs(lat) - 60, 2) * 0.01) * 0.3;
      const convective = Math.max(0, Math.sin(((hourOfDay - 14) / 24) * Math.PI * 2)) * 0.2;

      let coverage = itcz + storm30 + storm60 + convective;
      coverage = Math.max(0, Math.min(1, coverage + noise2D(lon, lat, 0.02) * 0.15));

      if (level !== 'surface') {
        coverage *= 0.6;
        coverage = Math.max(coverage, Math.abs(noise2D(lon, lat, 0.008)) * 0.3);
      }

      cloudFraction[idx] = coverage;

      // Humidity
      humidity[idx] = Math.max(0.1, Math.min(1,
        0.7 - Math.abs(lat) * 0.003 + coverage * 0.3 + noise2D(lon, lat, 0.015) * 0.1
      ));

      // Wind
      let uVal = 0, vVal = 0;
      if (Math.abs(lat) < 30) {
        uVal = -8 * Math.cos(latRad * 3);
        vVal = -2 * Math.sin(latRad * 6);
      } else if (Math.abs(lat) < 60) {
        uVal = 12 * Math.sin((Math.abs(lat) - 30) * Math.PI / 60);
        vVal = 3 * Math.cos(lonRad * 2 + dayOfYear * 0.01);
      } else {
        uVal = -5 * Math.cos(latRad * 2);
        vVal = 2 * Math.sin(lonRad);
      }
      uVal += noise2D(lon + 100, lat, 0.03) * 5;
      vVal += noise2D(lon, lat + 100, 0.03) * 3;

      const scale = getLevelWindScale(level);
      u[idx] = uVal * scale;
      v[idx] = vVal * scale;
      w[idx] = noise2D(lon, lat, 0.01) * 0.5 * scale;
    }
  }

  return {
    width, height, level, timestamp: time,
    fields: { cloudFraction, humidity, temperature, u, v, w },
  };
}

/**
 * Generate 3 cloud layers (low/mid/high) with distinct altitude characteristics.
 * Used as procedural fallback when GFS data is unavailable.
 */
export function generateCloudLayers(time: string, width: number, height: number) {
  const timeDate = new Date(time);
  const hourOfDay = timeDate.getUTCHours();
  const dayOfYear = Math.floor(
    (timeDate.getTime() - new Date(timeDate.getUTCFullYear(), 0, 0).getTime()) / 86400000
  );

  const low = new Float32Array(width * height);
  const medium = new Float32Array(width * height);
  const high = new Float32Array(width * height);
  const windU = new Float32Array(width * height);
  const windV = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const lon = (x / width) * 360 - 180;
      const lat = (y / height) * 180 - 90;
      const latRad = (lat * Math.PI) / 180;

      // ── Low clouds (stratus, stratocumulus) ─────────────────────
      // Dominated by marine stratocumulus off western coasts + ITCZ
      const marineStratus =
        Math.exp(-Math.pow(Math.abs(Math.abs(lat) - 30) - 15, 2) * 0.01) *
        Math.max(0, noise2D(lon, lat, 0.008)) * 0.7;
      const itczLow = Math.exp(-lat * lat * 0.004) * 0.6;
      const frontalLow = Math.exp(-Math.pow(Math.abs(lat) - 50, 2) * 0.006) *
        Math.max(0, noise2D(lon + 50, lat, 0.005)) * 0.5;
      low[idx] = Math.min(1, Math.max(0,
        marineStratus + itczLow + frontalLow + noise2D(lon, lat, 0.03) * 0.1
      ));

      // ── Medium clouds (altostratus, altocumulus) ────────────────
      // Associated with warm fronts, mid-latitude storms
      const stormTrack = Math.exp(-Math.pow(Math.abs(lat) - 45, 2) * 0.005) * 0.5;
      const warmFront = Math.exp(-Math.pow(Math.abs(lat) - 35, 2) * 0.008) *
        Math.max(0, noise2D(lon + 20, lat + 10, 0.006)) * 0.4;
      const itczMid = Math.exp(-lat * lat * 0.003) * 0.3;
      medium[idx] = Math.min(1, Math.max(0,
        stormTrack + warmFront + itczMid + noise2D(lon + 30, lat, 0.025) * 0.12
      ));

      // ── High clouds (cirrus, cirrostratus) ──────────────────────
      // Extensive in tropics, associated with jet streams at mid-latitudes
      const tropicalCirrus = Math.exp(-lat * lat * 0.002) * 0.5;
      const jetStream = Math.exp(-Math.pow(Math.abs(lat) - 40, 2) * 0.004) *
        Math.max(0, noise2D(lon, lat + 20, 0.004)) * 0.6;
      const polarCirrus = Math.exp(-Math.pow(Math.abs(lat) - 70, 2) * 0.008) * 0.3;
      high[idx] = Math.min(1, Math.max(0,
        tropicalCirrus + jetStream + polarCirrus + noise2D(lon + 60, lat + 30, 0.02) * 0.1
      ));

      // ── Wind (850hPa equivalent) ───────────────────────────────
      let uVal = 0, vVal = 0;
      if (Math.abs(lat) < 30) {
        uVal = -8 * Math.cos(latRad * 3);
        vVal = -2 * Math.sin(latRad * 6);
      } else if (Math.abs(lat) < 60) {
        uVal = 12 * Math.sin((Math.abs(lat) - 30) * Math.PI / 60);
        vVal = 3 * Math.cos((lon * Math.PI / 180) * 2 + dayOfYear * 0.01);
      } else {
        uVal = -5 * Math.cos(latRad * 2);
        vVal = 2 * Math.sin(lon * Math.PI / 180);
      }
      windU[idx] = uVal + noise2D(lon + 100, lat, 0.03) * 5;
      windV[idx] = vVal + noise2D(lon, lat + 100, 0.03) * 3;
    }
  }

  return {
    source: 'procedural',
    width, height,
    low: Array.from(low),
    medium: Array.from(medium),
    high: Array.from(high),
    windU: Array.from(windU),
    windV: Array.from(windV),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function getLevelWindScale(level: string): number {
  switch (level) {
    case 'surface': return 1.0;
    case '925hPa': return 1.1;
    case '850hPa': return 1.3;
    case '700hPa': return 1.5;
    case '500hPa': return 1.8;
    case '300hPa': case 'FL300': return 2.5;
    case '200hPa': return 2.2;
    case 'FL100': return 1.2;
    case 'FL200': return 1.8;
    default: return 1.0;
  }
}

function noise2D(x: number, y: number, scale: number): number {
  const sx = x * scale, sy = y * scale;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = sx - ix, fy = sy - iy;
  const sfx = fx * fx * (3 - 2 * fx), sfy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(ix, iy), n10 = hash2(ix + 1, iy);
  const n01 = hash2(ix, iy + 1), n11 = hash2(ix + 1, iy + 1);
  return (n00 + sfx * (n10 - n00)) + sfy * ((n01 + sfx * (n11 - n01)) - (n00 + sfx * (n10 - n00)));
}

function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff * 2 - 1;
}
