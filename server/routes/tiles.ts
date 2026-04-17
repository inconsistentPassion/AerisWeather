/**
 * Tile routes — Serve pre-rendered weather tiles for the globe.
 * Generates tiles from the procedural weather grid on-the-fly.
 */

import { Router } from 'express';
import { generateWeatherGrid } from '../normalize/grid';

export const tileRouter = Router();

// Tile cache (in-memory for simplicity)
const tileCache = new Map<string, { data: Buffer; expiry: number }>();
const TILE_CACHE_TTL = 300000; // 5 minutes

/**
 * GET /api/tiles/:field/:z/:x/:y.png
 * Serve a weather tile (wind, temp, pressure, clouds, humidity)
 */
tileRouter.get('/:field/:z/:x/:y.png', async (req, res) => {
  const { field, z, x, y } = req.params;
  const level = (req.query.level as string) || 'surface';
  const time = (req.query.time as string) || new Date().toISOString();

  const cacheKey = `${field}_${level}_${time}_${z}_${x}_${y}`;
  
  // Check cache
  const cached = tileCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(cached.data);
  }

  try {
    // Generate tile
    const png = generateTile(field, parseInt(z), parseInt(x), parseInt(y), level, time);
    
    // Cache
    tileCache.set(cacheKey, { data: png, expiry: Date.now() + TILE_CACHE_TTL });
    
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(png);
  } catch (err: any) {
    console.error(`[Tiles] Error generating ${field} tile:`, err.message);
    // Return transparent 1x1 PNG on error
    res.set('Content-Type', 'image/png');
    res.send(getTransparentPNG());
  }
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
    timeRange: {
      start: Date.now(),
      end: Date.now() + 120 * 3600 * 1000, // 120 hours
      stepHours: 3,
    },
    levels: ['surface', '925hPa', '850hPa', '700hPa', '500hPa', '300hPa', 'FL100', 'FL200', 'FL300'],
  });
});

/**
 * GET /api/tiles/cache/stats
 */
tileRouter.get('/cache/stats', (_req, res) => {
  let valid = 0;
  const now = Date.now();
  for (const entry of tileCache.values()) {
    if (entry.expiry > now) valid++;
  }
  res.json({ total: tileCache.size, valid });
});

/**
 * Generate a weather tile PNG from grid data.
 * Simple 256x256 colored tile based on field values.
 */
function generateTile(
  field: string,
  z: number,
  x: number,
  y: number,
  level: string,
  time: string
): Buffer {
  const size = 256;
  const zoomLevels = Math.pow(2, z);
  
  // Convert tile coordinates to lat/lon bounds
  const lonMin = (x / zoomLevels) * 360 - 180;
  const lonMax = ((x + 1) / zoomLevels) * 360 - 180;
  const latMax = 90 - (y / zoomLevels) * 180;
  const latMin = 90 - ((y + 1) / zoomLevels) * 180;

  // Get weather grid for this region
  const gridWidth = 360;
  const gridHeight = 180;
  const grid = generateWeatherGrid(level, time, gridWidth, gridHeight);

  // Create RGBA pixel data
  const pixels = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4;
      
      // Map pixel to lat/lon
      const lon = lonMin + (px / size) * (lonMax - lonMin);
      const lat = latMin + (py / size) * (latMax - latMin);
      
      // Map to grid cell
      const gx = Math.floor(((lon + 180) / 360) * gridWidth) % gridWidth;
      const gy = Math.floor(((90 - lat) / 180) * gridHeight);
      const gi = Math.max(0, Math.min(gridHeight - 1, gy)) * gridWidth +
                 Math.max(0, Math.min(gridWidth - 1, gx));

      // Get field value and apply color
      const color = getFieldColor(field, grid, gi);
      
      pixels[idx] = color[0];     // R
      pixels[idx + 1] = color[1]; // G
      pixels[idx + 2] = color[2]; // B
      pixels[idx + 3] = color[3]; // A
    }
  }

  // Encode as PNG (simple uncompressed PNG)
  return encodePNG(pixels, size, size);
}

/**
 * Get RGBA color for a field value at a grid index.
 */
function getFieldColor(field: string, grid: any, idx: number): [number, number, number, number] {
  switch (field) {
    case 'clouds': {
      const val = grid.cloudCoverage?.[Math.floor(idx / grid.width)]?.[idx % grid.width] ?? 0;
      // White with alpha = coverage
      return [255, 255, 255, Math.floor(val * 200)];
    }
    case 'temperature': {
      const val = grid.temperature?.[Math.floor(idx / grid.width)]?.[idx % grid.width] ?? 15;
      // Blue (cold) to red (hot)
      const norm = (val + 30) / 60; // -30 to 30 range
      const r = Math.floor(Math.max(0, Math.min(255, norm * 512 - 256)));
      const b = Math.floor(Math.max(0, Math.min(255, 256 - norm * 512)));
      return [r, 100, b, 150];
    }
    case 'pressure': {
      // Simplified: low = blue, high = red
      const lat = Math.floor(idx / grid.width);
      const latNorm = lat / grid.height;
      return [Math.floor(latNorm * 200), 100, Math.floor((1 - latNorm) * 200), 100];
    }
    case 'humidity': {
      const val = grid.humidity?.[Math.floor(idx / grid.width)]?.[idx % grid.width] ?? 0.5;
      // Blue gradient
      return [50, 100, 200, Math.floor(val * 180)];
    }
    case 'wind': {
      const u = grid.windU?.[Math.floor(idx / grid.width)]?.[idx % grid.width] ?? 0;
      const v = grid.windV?.[Math.floor(idx / grid.width)]?.[idx % grid.width] ?? 0;
      const speed = Math.sqrt(u * u + v * v);
      // Cyan to white based on speed
      const norm = Math.min(speed / 30, 1);
      return [Math.floor(100 + norm * 155), Math.floor(200 + norm * 55), 255, Math.floor(norm * 180)];
    }
    default:
      return [0, 0, 0, 0];
  }
}

/**
 * Simple PNG encoder (uncompressed, for tiles).
 * Creates a valid PNG with raw pixel data.
 */
function encodePNG(pixels: Uint8Array, width: number, height: number): Buffer {
  // Minimal PNG: IHDR + IDAT + IEND
  // For simplicity, return a small valid PNG
  
  // Create a canvas-sized colored rectangle as fallback
  // This is a simplified version - real implementation would use a PNG library
  const r = pixels[0] || 0;
  const g = pixels[1] || 0;
  const b = pixels[2] || 0;
  const a = pixels[3] || 255;
  
  // Create minimal RGBA PNG (2x2 scaled up)
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk (image header)
  const ihdr = createIHDRChunk(width, height);
  
  // IDAT chunk (image data) - create raw scanlines
  const rawData = createRawScanlines(pixels, width, height);
  const compressed = simpleDeflate(rawData);
  const idat = createChunk('IDAT', compressed);
  
  // IEND chunk
  const iend = createChunk('IDAT', Buffer.alloc(0)); // placeholder
  const iendReal = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iendReal]);
}

function createIHDRChunk(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;  // bit depth
  data[9] = 6;  // color type (RGBA)
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return createChunk('IHDR', data);
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const chunkData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(chunkData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  
  return Buffer.concat([length, chunkData, crcBuffer]);
}

function createRawScanlines(pixels: Uint8Array, width: number, height: number): Buffer {
  const bpp = 4; // RGBA
  const scanlineSize = 1 + width * bpp; // filter byte + pixel data
  const raw = Buffer.alloc(height * scanlineSize);
  
  for (let y = 0; y < height; y++) {
    const offset = y * scanlineSize;
    raw[offset] = 0; // filter: None
    
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = offset + 1 + x * 4;
      raw[dstIdx] = pixels[srcIdx];
      raw[dstIdx + 1] = pixels[srcIdx + 1];
      raw[dstIdx + 2] = pixels[srcIdx + 2];
      raw[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  
  return raw;
}

/**
 * Simple deflate-like compression (store method for PNG).
 */
function simpleDeflate(data: Buffer): Buffer {
  // Use store method (no compression) for simplicity
  // zlib format: CMF=0x78, FLG=0x01, then stored blocks
  const blocks: Buffer[] = [];
  const BLOCK_SIZE = 65535;
  
  for (let i = 0; i < data.length; i += BLOCK_SIZE) {
    const end = Math.min(i + BLOCK_SIZE, data.length);
    const block = data.slice(i, end);
    const isLast = end === data.length;
    
    const header = Buffer.alloc(5);
    header[0] = isLast ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    header.writeUInt16LE(block.length, 1);
    header.writeUInt16LE(~block.length & 0xFFFF, 3);
    
    blocks.push(Buffer.concat([header, block]));
  }
  
  // Adler32 checksum
  const adler = adler32(data);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler, 0);
  
  return Buffer.concat([
    Buffer.from([0x78, 0x01]), // zlib header
    ...blocks,
    adlerBuf,
  ]);
}

function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc ^ 0xFFFFFFFF;
}

function adler32(data: Buffer): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

function getTransparentPNG(): Buffer {
  // 1x1 transparent PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
}
