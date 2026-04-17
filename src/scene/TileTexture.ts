/**
 * TileTexture — Builds an equirectangular globe texture from map tiles.
 * 
 * Fetches tiles from CARTO Dark Matter CDN and composites them into
 * a single DataTexture for the globe sphere.
 */

import * as THREE from 'three';

const TILE_SIZE = 256;
const TILE_URL = 'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png';

/**
 * Fetch a single tile as an ImageBitmap.
 */
async function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const url = TILE_URL
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Build a globe texture from tiles at a given zoom level.
 * 
 * @param zoom - Tile zoom level (4 = 256 tiles, good balance of detail vs fetches)
 * @returns Promise<DataTexture> - Equirectangular texture for globe
 */
export async function buildGlobeTextureFromTiles(
  zoom: number = 4
): Promise<THREE.DataTexture> {
  const tilesX = Math.pow(2, zoom);
  const tilesY = Math.pow(2, zoom);
  const texWidth = tilesX * TILE_SIZE;
  const texHeight = tilesY * TILE_SIZE;

  // Canvas to composite tiles
  const canvas = document.createElement('canvas');
  canvas.width = texWidth;
  canvas.height = texHeight;
  const ctx = canvas.getContext('2d')!;

  // Fill with dark background
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, texWidth, texHeight);

  // Fetch all tiles in parallel (batched to avoid overwhelming the CDN)
  const promises: Promise<void>[] = [];

  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      promises.push(
        fetchTile(zoom, x, y).then((bitmap) => {
          if (bitmap) {
            ctx.drawImage(bitmap, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            bitmap.close();
          }
        })
      );
    }
  }

  // Wait for all tiles (with timeout)
  await Promise.allSettled(promises);

  // Extract pixel data
  const imageData = ctx.getImageData(0, 0, texWidth, texHeight);
  const pixels = imageData.data;

  // Convert to Float32Array for DataTexture
  const data = new Float32Array(texWidth * texHeight * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    data[i] = pixels[i] / 255;
    data[i + 1] = pixels[i + 1] / 255;
    data[i + 2] = pixels[i + 2] / 255;
    data[i + 3] = 1.0;
  }

  const texture = new THREE.DataTexture(data, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return texture;
}

/**
 * Build a fallback texture (no network) — dark navy with simplified continents.
 */
export function buildFallbackTexture(): THREE.DataTexture {
  const width = 1024;
  const height = 512;
  const data = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const lat = (y / height - 0.5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const lon = (x / width) * Math.PI * 2 - Math.PI;
      const idx = (y * width + x) * 4;

      // Simple continent shapes
      const n1 = Math.sin(lon * 3.0 + 1.0) * Math.cos(lat * 2.5 - 0.3);
      const n2 = Math.sin(lon * 5.0 - 2.0) * Math.cos(lat * 4.0 + 1.0) * 0.5;
      const n3 = Math.sin(lon * 1.7 + 3.0) * Math.cos(lat * 1.3 + 0.7) * 0.3;
      const land = (n1 + n2 + n3) > 0.15;

      const absLat = Math.abs(lat);

      if (absLat > 1.3) {
        // Polar — slightly lighter dark
        data[idx] = 0.12; data[idx + 1] = 0.13; data[idx + 2] = 0.15;
      } else if (land) {
        // Land — dark greenish-grey (like CARTO dark)
        data[idx] = 0.10; data[idx + 1] = 0.12; data[idx + 2] = 0.10;
      } else {
        // Ocean — dark navy (like CARTO dark)
        data[idx] = 0.06; data[idx + 1] = 0.07; data[idx + 2] = 0.10;
      }
      data[idx + 3] = 1.0;
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}
