/**
 * Weather API routes — GFS cloud layers + procedural fallback.
 */

import { Router } from 'express';
import { generateWeatherGrid, generateCloudLayers } from '../normalize/grid';
import { fetchGFSData, getCurrentCycle, resampleGrid } from '../sources/gfs';
import { weatherCache } from '../cache/disk';

export const weatherRouter = Router();

const GRID_W = 360;
const GRID_H = 180;

/**
 * GET /api/weather/grid?level=surface&time=...
 * Single-level weather grid (backward compatible).
 */
weatherRouter.get('/grid', async (req, res) => {
  const level = (req.query.level as string) || 'surface';
  const time = (req.query.time as string) || new Date().toISOString();
  const width = parseInt(req.query.width as string) || GRID_W;
  const height = parseInt(req.query.height as string) || GRID_H;

  const cacheKey = `grid_${level}_${time}_${width}x${height}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) return res.json(cached);

  const grid = generateWeatherGrid(level, time, width, height);
  weatherCache.set(cacheKey, grid);
  res.json(grid);
});

/**
 * GET /api/weather/cloud-layers?time=...
 * Returns 3 cloud layers (low/mid/high) from GFS or procedural fallback.
 */
weatherRouter.get('/cloud-layers', async (req, res) => {
  const time = (req.query.time as string) || new Date().toISOString();
  const width = parseInt(req.query.width as string) || GRID_W;
  const height = parseInt(req.query.height as string) || GRID_H;

  const cacheKey = `cloud-layers_${time}_${width}x${height}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) return res.json(cached);

  // Try GFS
  try {
    const cycle = getCurrentCycle();
    const now = Date.now();
    const targetTime = new Date(time).getTime();
    let fhour = Math.round((targetTime - now) / 3600000) + 3;
    fhour = Math.max(0, Math.min(fhour, 384));

    // Round to nearest 3-hour step
    fhour = Math.round(fhour / 3) * 3;

    const gfsData = await fetchGFSData(cycle, fhour);

    if (gfsData) {
      // Resample GFS 0.25° grid (1440×721) to target resolution
      const result = {
        source: 'GFS',
        cycle: gfsData.cycle,
        forecastHour: gfsData.forecastHour,
        width,
        height,
        low: Array.from(resampleGrid(gfsData.low.data, gfsData.low.width, gfsData.low.height, width, height)),
        medium: Array.from(resampleGrid(gfsData.medium.data, gfsData.medium.width, gfsData.medium.height, width, height)),
        high: Array.from(resampleGrid(gfsData.high.data, gfsData.high.width, gfsData.high.height, width, height)),
        windU: Array.from(resampleGrid(gfsData.windU, 1440, 721, width, height)),
        windV: Array.from(resampleGrid(gfsData.windV, 1440, 721, width, height)),
      };

      weatherCache.set(cacheKey, result);
      console.log(`[Weather] Cloud layers from GFS ${cycle.date}/${cycle.hour}+${fhour}h`);
      return res.json(result);
    }
  } catch (err) {
    console.warn(`[Weather] GFS cloud layers failed: ${(err as Error).message}`);
  }

  // Procedural fallback
  const layers = generateCloudLayers(time, width, height);
  layers.source = 'procedural';
  weatherCache.set(cacheKey, layers);
  res.json(layers);
});

/**
 * GET /api/weather/cycle
 */
weatherRouter.get('/cycle', (_req, res) => {
  const cycle = getCurrentCycle();
  res.json({ cycle });
});

/**
 * GET /api/weather/cache/stats
 */
weatherRouter.get('/cache/stats', (_req, res) => {
  res.json({ sizeMB: weatherCache.getSizeMB() });
});

/**
 * POST /api/weather/cache/clear
 */
weatherRouter.post('/cache/clear', (_req, res) => {
  weatherCache.clear();
  res.json({ status: 'cleared' });
});
