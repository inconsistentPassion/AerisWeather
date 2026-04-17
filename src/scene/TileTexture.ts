/**
 * TileTexture — Streaming tile engine for the globe.
 *
 * Renders CARTO Dark Matter tiles onto a canvas texture that updates
 * incrementally as the zoom level changes. Uses CanvasTexture (Uint8)
 * instead of DataTexture (Float32) for broad GPU compatibility.
 *
 * Design:
 *  - Single canvas that gets resized per zoom level
 *  - Tile cache to avoid re-fetching
 *  - Background loading with priority for visible tiles
 *  - Blends from low-res to high-res as tiles arrive
 */

import * as THREE from 'three';

const TILE_SIZE = 256;
const TILE_URL = 'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png';

// Zoom level limits
const MIN_ZOOM = 1;
const MAX_ZOOM = 6; // 6 = 4096×2048, good detail, ~64 tiles max

export interface TileEngine {
  /** The canvas texture — assign to material.map */
  texture: THREE.CanvasTexture;
  /** Set the target zoom level. Triggers tile loading if changed. */
  setZoom(zoom: number): void;
  /** Get current effective zoom */
  getZoom(): number;
  /** Check if tiles are still loading */
  isLoading(): boolean;
  /** Cleanup */
  dispose(): void;
}

// ── Tile fetcher with cache ───────────────────────────────────────────

const tileCache = new Map<string, ImageBitmap>();

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

async function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const key = tileKey(z, x, y);

  // Return from cache if available
  const cached = tileCache.get(key);
  if (cached) return cached;

  const url = TILE_URL
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    tileCache.set(key, bitmap);
    return bitmap;
  } catch {
    return null;
  }
}

// ── Prune cache to avoid memory bloat ─────────────────────────────────

function pruneCache(currentZoom: number, maxEntries = 512): void {
  if (tileCache.size <= maxEntries) return;

  // Keep tiles near current zoom, evict distant ones
  for (const [key] of tileCache) {
    const z = parseInt(key.split('/')[0], 10);
    if (Math.abs(z - currentZoom) > 2) {
      const bitmap = tileCache.get(key);
      if (bitmap) bitmap.close();
      tileCache.delete(key);
    }
  }

  // If still too large, evict oldest (map iteration order = insertion order)
  while (tileCache.size > maxEntries) {
    const firstKey = tileCache.keys().next().value!;
    const bitmap = tileCache.get(firstKey);
    if (bitmap) bitmap.close();
    tileCache.delete(firstKey);
  }
}

// ── Tile Engine ───────────────────────────────────────────────────────

export function createTileEngine(): TileEngine {
  // Canvas for compositing tiles
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  // Start at zoom 2 (small, fast)
  let currentZoom = 2;
  let targetZoom = 2;
  let loading = false;

  // Size canvas for initial zoom
  resizeCanvas(canvas, ctx, currentZoom);

  // Create Three.js texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // Track in-flight loads so we don't duplicate
  const inflight = new Set<string>();

  /**
   * Load all tiles for a given zoom level and composite onto canvas.
   * Tiles are loaded in batches to avoid flooding the CDN.
   */
  async function loadTilesForZoom(zoom: number): Promise<void> {
    const tilesX = Math.pow(2, zoom);
    const tilesY = Math.pow(2, zoom);

    // If this is a lower zoom than what we already have rendered,
    // we can skip (we'll keep the higher-res texture)
    if (zoom < currentZoom && canvas.width >= Math.pow(2, zoom) * TILE_SIZE) {
      return;
    }

    loading = true;

    // Resize canvas for new zoom
    resizeCanvas(canvas, ctx, zoom);
    currentZoom = zoom;

    // Clear with dark background
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // If we have tiles in cache from a nearby zoom, draw a scaled version first
    // so the texture isn't blank while new tiles load
    drawScaledFallback(ctx, canvas, zoom);

    // Load tiles in batches (row by row for progressive reveal)
    const batchSize = 8;
    const allTiles: Array<{ x: number; y: number }> = [];

    for (let y = 0; y < tilesY; y++) {
      for (let x = 0; x < tilesX; x++) {
        allTiles.push({ x, y });
      }
    }

    for (let i = 0; i < allTiles.length; i += batchSize) {
      // Abort if zoom changed during loading
      if (targetZoom !== zoom) {
        loading = false;
        return;
      }

      const batch = allTiles.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(({ x, y }) => {
          const key = tileKey(zoom, x, y);
          if (inflight.has(key)) return Promise.resolve(null);
          inflight.add(key);
          return fetchTile(zoom, x, y).finally(() => inflight.delete(key));
        })
      );

      let anyDrawn = false;
      for (let j = 0; j < batch.length; j++) {
        const { x, y } = batch[j];
        const result = results[j];
        if (result.status === 'fulfilled' && result.value) {
          ctx.drawImage(result.value, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          anyDrawn = true;
        }
      }

      // Update texture after each batch for progressive rendering
      if (anyDrawn) {
        texture.needsUpdate = true;
      }
    }

    loading = false;
    texture.needsUpdate = true;
    pruneCache(zoom);
  }

  function setZoom(zoom: number): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
    if (clamped === targetZoom) return;

    targetZoom = clamped;

    // Only reload if we need higher detail (going deeper)
    // or if the gap is large enough to matter
    if (clamped > currentZoom || Math.abs(clamped - currentZoom) >= 1) {
      loadTilesForZoom(clamped);
    }
  }

  function getZoom(): number {
    return currentZoom;
  }

  function isLoading(): boolean {
    return loading;
  }

  function dispose(): void {
    texture.dispose();
    // Don't close cached bitmaps — they may be reused
  }

  return { texture, setZoom, getZoom, isLoading, dispose };
}

// ── Helpers ───────────────────────────────────────────────────────────

function resizeCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  zoom: number
): void {
  const size = Math.pow(2, zoom) * TILE_SIZE;
  canvas.width = size;
  canvas.height = size / 2; // Equirectangular is 2:1
}

/**
 * Draw a scaled version of previously-loaded tiles as a placeholder.
 * This avoids a blank texture during zoom transitions.
 */
function drawScaledFallback(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  targetZoom: number
): void {
  // Try to find cached tiles from a nearby zoom level
  for (let dz = targetZoom - 1; dz >= MIN_ZOOM; dz--) {
    const srcTiles = Math.pow(2, dz);
    let foundAny = false;

    for (let y = 0; y < srcTiles && y < Math.pow(2, targetZoom); y++) {
      for (let x = 0; x < srcTiles && x < Math.pow(2, targetZoom); x++) {
        const key = tileKey(dz, x, y);
        const bitmap = tileCache.get(key);
        if (bitmap) {
          foundAny = true;
          // Scale up: each source tile covers multiple target tiles
          const scale = Math.pow(2, targetZoom - dz);
          const dstX = x * scale * TILE_SIZE;
          const dstY = y * scale * TILE_SIZE;
          const dstW = scale * TILE_SIZE;
          const dstH = scale * TILE_SIZE;
          ctx.drawImage(bitmap, dstX, dstY, dstW, dstH);
        }
      }
    }

    if (foundAny) break; // Use the highest-res fallback we have
  }
}
