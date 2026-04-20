/**
 * Tile routes — cloud intensity textures for volumetric rendering.
 */

import { Router } from 'express';
import { buildCloudTexture } from '../texture/composer';

export const tileRouter = Router();

// In-memory cache
const texCache = new Map<string, { data: any; expiry: number }>();
const CACHE_TTL = 3600_000; // 1 hour

/**
 * GET /api/tiles/cloud-texture/:z/:x/:y.png
 * Cloud intensity texture tile for volumetric rendering.
 * Returns JSON with Float32 data arrays.
 */
tileRouter.get('/cloud-texture/:z/:x/:y.png', async (req, res) => {
  const { z, x, y } = req.params;
  const cacheKey = `ct_${z}_${x}_${y}`;

  // Cache check
  const cached = texCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json(cached.data);
  }

  try {
    const zoom = Math.pow(2, parseInt(z));
    const tx = parseInt(x);
    const ty = parseInt(y);

    const lonMin = (tx / zoom) * 360 - 180;
    const lonMax = ((tx + 1) / zoom) * 360 - 180;
    const latMax = 90 - (ty / zoom) * 180;
    const latMin = 90 - ((ty + 1) / zoom) * 180;

    const tex = await buildCloudTexture(lonMin, lonMax, latMin, latMax, 256, 256);

    const response = {
      width: tex.width,
      height: tex.height,
      data: Array.from(tex.data),
      windU: Array.from(tex.windU),
      windV: Array.from(tex.windV),
      source: tex.source,
      timestamp: tex.timestamp,
      bounds: { lonMin, lonMax, latMin, latMax },
      ...(tex.layers ? {
        layers: {
          low: Array.from(tex.layers.low),
          medium: Array.from(tex.layers.medium),
          high: Array.from(tex.layers.high),
        }
      } : {}),
    };

    texCache.set(cacheKey, { data: response, expiry: Date.now() + CACHE_TTL });

    res.set('Cache-Control', 'public, max-age=3600');
    res.set('ETag', `"ct-${z}-${x}-${y}-${Math.floor(Date.now() / 3600000)}"`);
    res.json(response);

    console.log(`[Tiles] Cloud texture ${z}/${x}/${y} from ${tex.source}`);
  } catch (err: any) {
    console.error(`[Tiles] Cloud texture error:`, err.message);
    res.status(500).json({ error: 'Texture generation failed' });
  }
});
