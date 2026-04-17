/**
 * Weather API routes — Proxy and normalize data from external sources.
 */

import { Router } from 'express';
import { fetchGFSData } from '../sources/gfs';

export const weatherRouter = Router();

/**
 * GET /api/weather/grid?level=surface&field=clouds
 * Returns normalized gridded weather data.
 */
weatherRouter.get('/grid', async (req, res) => {
  const level = (req.query.level as string) || 'surface';
  const field = (req.query.field as string) || 'all';

  try {
    // TODO: Implement proper GFS fetching and caching
    // For now, return placeholder
    const grid = generatePlaceholderGrid(360, 180, field);
    res.json({ level, field, grid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/weather/forecast?level=surface&hours=72
 * Returns time-series of forecast grids.
 */
weatherRouter.get('/forecast', async (req, res) => {
  const level = (req.query.level as string) || 'surface';
  const hours = parseInt((req.query.hours as string) || '72');

  try {
    // TODO: Return actual forecast time series
    res.json({ level, hours, steps: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function generatePlaceholderGrid(width: number, height: number, field: string) {
  const data = new Float32Array(width * height);

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const idx = j * width + i;
      const nx = i / width * 4;
      const ny = j / height * 4;
      data[idx] = (Math.sin(nx * 3.7 + ny * 2.3) * 0.5 + 0.5) *
                  (Math.cos(nx * 1.3 - ny * 4.1) * 0.5 + 0.5);
    }
  }

  return {
    width,
    height,
    field,
    data: Array.from(data), // JSON-safe (Float32Array can't be serialized directly)
  };
}
