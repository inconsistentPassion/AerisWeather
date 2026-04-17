/**
 * Weather API routes — Proxy and normalize data from external sources.
 */

import { Router } from 'express';
import { generateWeatherGrid } from '../normalize/grid';

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

  try {
    const grid = generateWeatherGrid(level, time, width, height);
    res.json(grid);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
