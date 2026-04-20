/**
 * RadarData — Real precipitation data from RainViewer radar tiles.
 *
 * Fetches the latest radar frame, downloads tiles, reads pixel data
 * to extract precipitation cells with lon/lat/intensity.
 * Used by DeckLayers for radar-based rain visualization.
 */

const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const TILE_PX = 256;
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

export interface PrecipCell {
  lon: number;
  lat: number;
  intensity: number; // 0-1
}

function pixelToLon(tx: number, px: number, z: number): number {
  return ((tx + px / TILE_PX) / (1 << z)) * 360 - 180;
}

function pixelToLat(ty: number, py: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * (ty + py / TILE_PX) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

let cachedCells: PrecipCell[] = [];
let lastFetchTime = 0;
let fetchInProgress = false;

/**
 * Load latest radar data from RainViewer.
 * Returns cached cells if recently fetched.
 */
export async function loadRadarCells(): Promise<PrecipCell[]> {
  // Return cache if fresh
  if (cachedCells.length > 0 && Date.now() - lastFetchTime < REFRESH_INTERVAL) {
    return cachedCells;
  }

  // Don't start concurrent fetches
  if (fetchInProgress) return cachedCells;

  fetchInProgress = true;
  try {
    const res = await fetch(RAINDVIEWER_API);
    if (!res.ok) {
      console.warn('[Radar] RainViewer API error:', res.status);
      return cachedCells;
    }

    const data = await res.json();
    const host = data.host || 'https://tilecache.rainviewer.com';
    const past = data.radar?.past || [];
    if (!past.length) {
      console.log('[Radar] No radar frames available');
      return cachedCells;
    }

    const latest = past[past.length - 1];
    const basePath = `${host}${latest.path}/256`;
    const zoom = 3; // Low zoom = global overview
    const cells: PrecipCell[] = [];
    const STRIDE = 4; // Sample every 4th pixel

    // Load all tiles at this zoom level
    const tilePromises: Promise<void>[] = [];
    for (let ty = 0; ty < (1 << zoom); ty++) {
      for (let tx = 0; tx < (1 << zoom); tx++) {
        const url = `${basePath}/${zoom}/${tx}/${ty}/2/1_1.png`;
        tilePromises.push(new Promise<void>(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = TILE_PX;
              canvas.height = TILE_PX;
              const ctx = canvas.getContext('2d')!;
              ctx.drawImage(img, 0, 0);
              const pixels = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;

              for (let py = 0; py < TILE_PX; py += STRIDE) {
                for (let pxx = 0; pxx < TILE_PX; pxx += STRIDE) {
                  const idx = (py * TILE_PX + pxx) * 4;
                  const r = pixels[idx];
                  const g = pixels[idx + 1];
                  const b = pixels[idx + 2];
                  const a = pixels[idx + 3];

                  // Luminance × alpha = precipitation intensity
                  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  const intensity = lum * (a / 255);

                  if (intensity > 0.08) {
                    const lon = pixelToLon(tx, pxx + STRIDE / 2, zoom);
                    const lat = pixelToLat(ty, py + STRIDE / 2, zoom);
                    cells.push({ lon, lat, intensity: Math.min(1, intensity * 1.5) });
                  }
                }
              }
            } catch (e) {
              // Canvas tainted or other error
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        }));
      }
    }

    await Promise.all(tilePromises);

    cachedCells = cells;
    lastFetchTime = Date.now();
    console.log(`[Radar] ${cells.length} precipitation cells loaded`);
    return cells;
  } catch (e) {
    console.warn('[Radar] Load failed:', e);
    return cachedCells;
  } finally {
    fetchInProgress = false;
  }
}

/**
 * Get current cached radar cells (no fetch).
 */
export function getCachedRadarCells(): PrecipCell[] {
  return cachedCells;
}
