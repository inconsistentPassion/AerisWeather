/**
 * Grid — Weather grid normalization and procedural generation.
 * 
 * Generates realistic-ish weather grids for development/demo purposes.
 * Replace with real GFS/NOAA data fetching for production.
 */

import type { WeatherGrid } from '../../src/weather/types';

/**
 * Generate a complete weather grid with realistic patterns.
 * Includes ITCZ, storm tracks, trade winds, westerlies, polar easterlies.
 */
export function generateWeatherGrid(
  level: string,
  time: string,
  width: number,
  height: number
) {
  const timeDate = new Date(time);
  const hourOfDay = timeDate.getUTCHours();
  const dayOfYear = Math.floor(
    (timeDate.getTime() - new Date(timeDate.getUTCFullYear(), 0, 0).getTime()) / 86400000
  );

  const cloudCoverage: number[][] = [];
  const humidity: number[][] = [];
  const windU: number[][] = [];
  const windV: number[][] = [];
  const windW: number[][] = [];
  const temperature: number[][] = [];

  for (let y = 0; y < height; y++) {
    cloudCoverage[y] = [];
    humidity[y] = [];
    windU[y] = [];
    windV[y] = [];
    windW[y] = [];
    temperature[y] = [];

    for (let x = 0; x < width; x++) {
      const lon = (x / width) * 360 - 180;
      const lat = (y / height) * 180 - 90;
      const latRad = (lat * Math.PI) / 180;
      const lonRad = (lon * Math.PI) / 180;

      // ── Temperature ──────────────────────────────────────────────
      const baseTemp = 15 - Math.abs(lat) * 0.6;
      const diurnal = Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2) * 5;
      const seasonal = Math.sin(((dayOfYear - 80) / 365) * Math.PI * 2) * 10 * Math.cos(latRad);
      temperature[y][x] = baseTemp + diurnal + seasonal + noise2D(lon, lat, 0.01) * 3;

      // ── Cloud Coverage ───────────────────────────────────────────
      // ITCZ (inter-tropical convergence zone)
      const itcz = Math.exp(-lat * lat * 0.003) * 0.5;
      // Mid-latitude storm tracks (30-60°)
      const storm30 = Math.exp(-Math.pow(Math.abs(lat) - 45, 2) * 0.005) * 0.4;
      const storm60 = Math.exp(-Math.pow(Math.abs(lat) - 60, 2) * 0.01) * 0.3;
      // Orographic effects
      const orographic = Math.abs(noise2D(lon, lat, 0.005)) * 0.2;
      // Diurnal convective cycle
      const convective = Math.max(0, Math.sin(((hourOfDay - 14) / 24) * Math.PI * 2)) * 0.2;

      let coverage = itcz + storm30 + storm60 + orographic + convective;
      coverage = Math.max(0, Math.min(1, coverage + noise2D(lon, lat, 0.02) * 0.15));

      // Level adjustments — higher levels have more cirrus, less convective
      if (level === '500hPa' || level === '500' || level === '300hPa' || level === '300' ||
          level === 'FL200' || level === 'FL300' || level === 'FL450') {
        coverage *= 0.6;
        coverage = Math.max(coverage, Math.abs(noise2D(lon, lat, 0.008)) * 0.3);
      }

      cloudCoverage[y][x] = coverage;

      // ── Humidity ──────────────────────────────────────────────────
      const baseHumidity = 0.7 - Math.abs(lat) * 0.003;
      humidity[y][x] = Math.max(0.1, Math.min(1, baseHumidity + coverage * 0.3 + noise2D(lon, lat, 0.015) * 0.1));

      // ── Wind (u, v components) ───────────────────────────────────
      let u = 0;
      let v = 0;

      if (Math.abs(lat) < 30) {
        // Trade winds (easterlies)
        u = -8 * Math.cos(latRad * 3);
        v = -2 * Math.sin(latRad * 6);
      } else if (Math.abs(lat) < 60) {
        // Westerlies
        u = 12 * Math.sin((Math.abs(lat) - 30) * Math.PI / 60);
        v = 3 * Math.cos(lonRad * 2 + dayOfYear * 0.01);
      } else {
        // Polar easterlies
        u = -5 * Math.cos(latRad * 2);
        v = 2 * Math.sin(lonRad);
      }

      // Add turbulence
      u += noise2D(lon + 100, lat, 0.03) * 5;
      v += noise2D(lon, lat + 100, 0.03) * 3;

      // Scale by level
      const levelScale = getLevelWindScale(level);
      u *= levelScale;
      v *= levelScale;

      windU[y][x] = u;
      windV[y][x] = v;
      windW[y][x] = noise2D(lon, lat, 0.01) * 0.5 * levelScale;
    }
  }

  return {
    width,
    height,
    level,
    timestamp: time,
    cloudCoverage,
    humidity,
    windU,
    windV,
    windW,
    temperature,
    fields: {
      cloudFraction: flattenToFloat32(cloudCoverage, width, height),
      humidity: flattenToFloat32(humidity, width, height),
      temperature: flattenToFloat32(temperature, width, height),
      u: flattenToFloat32(windU, width, height),
      v: flattenToFloat32(windV, width, height),
      w: flattenToFloat32(windW, width, height),
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function getLevelWindScale(level: string): number {
  switch (level) {
    case 'surface': return 1.0;
    case '925hPa': return 1.1;
    case '850hPa': case '850': return 1.3;
    case '700hPa': case '700': return 1.5;
    case '500hPa': case '500': return 1.8;
    case '300hPa': case '300': return 2.5; // Jet stream level
    case '200hPa': case '200': return 2.2;
    case 'FL100': return 1.2;
    case 'FL200': return 1.8;
    case 'FL300': return 2.5;
    case 'FL450': return 2.2;
    default: return 1.0;
  }
}

function noise2D(x: number, y: number, scale: number): number {
  const sx = x * scale;
  const sy = y * scale;
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const sfx = fx * fx * (3 - 2 * fx);
  const sfy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(ix, iy);
  const n10 = hash2(ix + 1, iy);
  const n01 = hash2(ix, iy + 1);
  const n11 = hash2(ix + 1, iy + 1);
  const nx0 = n00 + sfx * (n10 - n00);
  const nx1 = n01 + sfx * (n11 - n01);
  return nx0 + sfy * (nx1 - nx0);
}

function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff * 2 - 1;
}

function flattenToFloat32(grid: number[][], w: number, h: number): Float32Array {
  const arr = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      arr[y * w + x] = grid[y][x];
    }
  }
  return arr;
}
