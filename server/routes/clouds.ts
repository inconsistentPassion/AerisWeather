/**
 * Cloud point data endpoint — GFS primary, NASA POWER fallback.
 *
 * GET /api/weather/clouds?lat={lat}&lon={lon}&time={iso}&debug={bool}
 *
 * Returns per-pressure-level cloud data for a single geographic point.
 * Primary: NOAA GFS 0.25° (pressure-level cloud fraction, water/ice mixing ratios)
 * Fallback: NASA POWER (daily low/mid/high + hourly optical depth)
 *
 * Response schema:
 * {
 *   source: "GFS" | "POWER",
 *   time: string,
 *   levels: number[] | string[],
 *   cloud_fraction: number[],
 *   cloud_water: number[] | null,
 *   cloud_ice: number[] | null,
 *   optical_depth: number | null,
 *   confidence: "high" | "medium" | "low"
 * }
 */

import { Router, Request, Response } from 'express';
import { fetchGFSPointCloud, getCurrentCycle } from '../sources/gfs';
import { fetchPOWERCloudData } from '../sources/power';
import { weatherCache } from '../cache/disk';

export const cloudRouter = Router();

/** Validate and parse query params */
function parseParams(req: Request): { lat: number; lon: number; time: string; debug: boolean } | null {
  const lat = parseFloat(req.query.lat as string);
  const lon = parseFloat(req.query.lon as string);
  const time = (req.query.time as string) || new Date().toISOString();
  const debug = req.query.debug === 'true';

  if (isNaN(lat) || lat < -90 || lat > 90) return null;
  if (isNaN(lon) || lon < -180 || lon > 180) return null;

  return { lat, lon, time, debug };
}

/**
 * GET /api/weather/clouds
 *
 * Query params:
 *   lat  (required) -90 to 90
 *   lon  (required) -180 to 180
 *   time (optional) ISO 8601 timestamp, defaults to now
 *   debug (optional) "true" to include raw source metadata
 *
 * Response:
 *   200 - Cloud data (GFS or POWER source)
 *   400 - Invalid parameters
 *   422 - Future date requested, POWER couldn't provide data
 *   503 - Both GFS and POWER failed
 */
cloudRouter.get('/clouds', async (req: Request, res: Response) => {
  const params = parseParams(req);
  if (!params) {
    return res.status(400).json({
      error: 'Invalid parameters',
      message: 'lat (-90..90) and lon (-180..180) are required',
    });
  }

  const { lat, lon, time, debug } = params;

  // Set cache headers
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', `"clouds-${lat.toFixed(2)}-${lon.toFixed(2)}-${time.slice(0, 13)}"`);

  // Check client ETag
  if (req.headers['if-none-match'] === res.get('ETag')) {
    return res.status(304).end();
  }

  // Check disk cache
  const cacheKey = `clouds_${lat.toFixed(2)}_${lon.toFixed(2)}_${time.slice(0, 13)}`;
  if (!debug) {
    const cached = weatherCache.get(cacheKey) as any;
    if (cached) {
      return res.json(cached);
    }
  }

  // ── Attempt 1: GFS ──────────────────────────────────────────────
  let gfsError: string | null = null;

  try {
    const cycle = getCurrentCycle();
    const now = Date.now();
    const targetTime = new Date(time).getTime();
    let fhour = Math.round((targetTime - now) / 3600000);
    fhour = Math.max(0, Math.min(fhour, 384));
    fhour = Math.round(fhour / 3) * 3; // GFS forecast hours are 3-hourly

    console.log(`[Clouds] Trying GFS: cycle=${cycle.date}/${cycle.hour} f${fhour}h for (${lat}, ${lon})`);

    const gfsData = await fetchGFSPointCloud(cycle, fhour, lat, lon, debug);

    if (gfsData && gfsData.levels.length > 0) {
      // GFS succeeded
      const response = {
        source: gfsData.source,
        time: gfsData.time,
        levels: gfsData.levels,
        cloud_fraction: gfsData.cloud_fraction,
        cloud_water: gfsData.cloud_water,
        cloud_ice: gfsData.cloud_ice,
        optical_depth: gfsData.optical_depth,
        confidence: gfsData.confidence,
        ...(debug ? { debug: gfsData.debug } : {}),
      };

      weatherCache.set(cacheKey, response);
      console.log(`[Clouds] GFS success: ${gfsData.levels.length} levels, confidence=${gfsData.confidence}`);
      return res.json(response);
    }

    gfsError = gfsData === null ? 'GFS fetch returned null' : 'GFS returned no level data';
  } catch (err) {
    gfsError = (err as Error).message;
    console.warn(`[Clouds] GFS error: ${gfsError}`);
  }

  // ── Attempt 2: NASA POWER fallback ──────────────────────────────
  console.log(`[Clouds] GFS failed (${gfsError}), falling back to NASA POWER`);

  try {
    const powerData = await fetchPOWERCloudData(lat, lon, time, debug);

    if (powerData) {
      const response = {
        source: powerData.source,
        time: powerData.time,
        levels: powerData.levels,
        cloud_fraction: powerData.cloud_fraction,
        cloud_water: powerData.cloud_water,
        cloud_ice: powerData.cloud_ice,
        optical_depth: powerData.optical_depth,
        confidence: powerData.confidence,
        spatial_resolution: powerData.spatial_resolution,
        fallback_reason: gfsError,
        ...(debug ? { debug: powerData.debug } : {}),
      };

      weatherCache.set(cacheKey, response);
      console.log(`[Clouds] POWER fallback success, confidence=${powerData.confidence}`);
      return res.json(response);
    }

    // POWER also failed
    const isFuture = new Date(time).getTime() > Date.now();
    return res.status(isFuture ? 422 : 503).json({
      error: isFuture ? 'Future date not supported' : 'Service unavailable',
      message: isFuture
        ? 'NASA POWER does not support future dates. GFS data was also unavailable.'
        : 'Both GFS and NASA POWER sources failed.',
      source: null,
      confidence: 'low',
      fallback_status: {
        gfs_error: gfsError,
        power_error: 'POWER returned no data',
      },
      ...(debug ? { debug: { gfsError, powerAttempted: true } } : {}),
    });
  } catch (err) {
    const powerError = (err as Error).message;
    console.warn(`[Clouds] POWER fallback also failed: ${powerError}`);

    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Both GFS and NASA POWER sources failed.',
      source: null,
      confidence: 'low',
      fallback_status: {
        gfs_error: gfsError,
        power_error: powerError,
      },
      ...(debug ? { debug: { gfsError, powerError } } : {}),
    });
  }
});
