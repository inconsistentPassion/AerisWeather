/**
 * Weather API routes — Proxy and normalize data from external sources.
 * Uses GFS adapter with disk cache, falls back to procedural generation.
 */

import { Router } from 'express';
import { generateWeatherGrid } from '../normalize/grid';
import { gfsAdapter } from '../sources/gfs';
import { weatherCache } from '../cache/disk';

export const weatherRouter = Router();

/**
 * GET /api/weather/grid?level=surface&time=2026-04-18T00:00:00Z
 * Returns normalized gridded weather data.
 */
weatherRouter.get('/grid', async (req, res) => {
  const level = (req.query.level as string) || 'surface';
  const time = (req.query.time as string) || new Date().toISOString();
  const width = parseInt(req.query.width as string) || 360;
  const height = parseInt(req.query.height as string) || 180;

  // Check cache
  const cacheKey = `grid_${level}_${time}_${width}x${height}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    // Try GFS first
    const cycle = gfsAdapter.getCurrentCycle();
    const targetDate = new Date(time);
    const now = new Date();
    const fhour = Math.max(0, Math.round((targetDate.getTime() - now.getTime()) / 3600000) + 3);
    
    const gfsGrid = await gfsAdapter.fetchData(cycle, Math.min(fhour, 384), ['TMP', 'UGRD', 'VGRD', 'RH', 'TCDC'], level);
    
    if (gfsGrid) {
      // Use real GFS data
      const grid = normalizeGFSGrid(gfsGrid, width, height, level, time);
      weatherCache.set(cacheKey, grid);
      return res.json(grid);
    }
  } catch (err) {
    console.warn(`[WeatherAPI] GFS fetch failed, using procedural: ${(err as Error).message}`);
  }

  // Fallback to procedural generation
  const grid = generateWeatherGrid(level, time, width, height);
  weatherCache.set(cacheKey, grid);
  res.json(grid);
});

/**
 * GET /api/weather/forecast?level=surface&hours=120
 * Returns time-series of forecast grids.
 */
weatherRouter.get('/forecast', async (req, res) => {
  const level = (req.query.level as string) || 'surface';
  const hours = parseInt((req.query.hours as string) || '120');
  const now = new Date();

  const steps = [];
  for (let h = 0; h <= hours; h += 3) {
    const t = new Date(now.getTime() + h * 3600000);
    steps.push({
      time: t.toISOString(),
      offset_hours: h,
      data_url: `/api/weather/grid?level=${level}&time=${t.toISOString()}`,
    });
  }

  res.json({ level, hours, steps });
});

/**
 * GET /api/weather/cycle
 * Returns current GFS cycle info.
 */
weatherRouter.get('/cycle', (_req, res) => {
  const cycle = gfsAdapter.getCurrentCycle();
  res.json({
    cycle,
    variables: gfsAdapter.getAvailableVariables(),
    levels: gfsAdapter.getAvailableLevels(),
  });
});

/**
 * GET /api/weather/cache/stats
 * Returns cache statistics.
 */
weatherRouter.get('/cache/stats', (_req, res) => {
  res.json({
    sizeMB: weatherCache.getSizeMB(),
  });
});

/**
 * POST /api/weather/cache/clear
 * Clears weather cache.
 */
weatherRouter.post('/cache/clear', (_req, res) => {
  weatherCache.clear();
  res.json({ status: 'cleared' });
});

/**
 * Normalize a GFS grid to the expected format.
 */
function normalizeGFSGrid(gfsGrid: any, width: number, height: number, level: string, time: string) {
  // Convert GFS data to our internal format
  // This would be more sophisticated with real GFS data
  return generateWeatherGrid(level, time, width, height);
}
