/**
 * Tile routes — Serve pre-rendered weather tiles for the globe.
 */

import { Router } from 'express';

export const tileRouter = Router();

/**
 * GET /api/tiles/:field/:z/:x/:y.png
 * Serve a weather tile (wind, temp, pressure, clouds, etc.)
 */
tileRouter.get('/:field/:z/:x/:y.png', async (req, res) => {
  const { field, z, x, y } = req.params;

  // TODO: Generate or serve cached tiles
  // For now, return a 1x1 transparent PNG placeholder
  const transparentPNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(transparentPNG);
});

/**
 * GET /api/tiles/:field/meta
 * Return tile metadata (available zoom levels, time range, etc.)
 */
tileRouter.get('/:field/meta', (req, res) => {
  const { field } = req.params;

  res.json({
    field,
    minZoom: 0,
    maxZoom: 6,
    tileSize: 256,
    // TODO: Fill with actual time range from data source
    timeRange: {
      start: Date.now(),
      end: Date.now() + 72 * 3600 * 1000,
      stepHours: 3,
    },
  });
});
