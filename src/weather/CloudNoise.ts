/**
 * CloudNoise — Procedural noise texture for volumetric cloud shapes.
 *
 * Technique: Horizon: Zero Dawn style (simplified for web)
 * - Multi-octave Perlin-Worley noise on a 2D canvas texture
 * - Texture values control: cloud presence, density, height variation
 * - Higher octaves = finer detail (cumulus bumps, cirrus wisps)
 *
 * Output: Float32Array noise grid (width × height), values 0-1
 */

/**
 * Simple hash-based 2D noise (no dependencies)
 */
function hash2D(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

/**
 * Smooth interpolation
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Bilinear interpolated value noise
 */
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);

  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);

  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Worley noise (cellular noise) — returns distance to nearest feature point
 */
function worleyNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  let minDist = 1.0;

  // Check 3×3 neighborhood
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      // Random point in cell
      const px = hash2D(cx * 73 + 17, cy * 157 + 31);
      const py = hash2D(cx * 89 + 43, cy * 131 + 67);
      const dist = Math.sqrt((dx + px - fx) ** 2 + (dy + py - fy) ** 2);
      minDist = Math.min(minDist, dist);
    }
  }

  return minDist;
}

/**
 * Fractal Brownian Motion (fBm) — multiple octaves of value noise
 */
function fbm(x: number, y: number, octaves: number, lacunarity: number = 2.0, gain: number = 0.5): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxVal = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, y * frequency);
    maxVal += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return value / maxVal;
}

/**
 * Generate a cloud shape noise grid.
 *
 * The noise defines cloud "coverage" at each point:
 * - 0 = clear sky
 * - 1 = thick cloud
 *
 * Uses Perlin fBm for base shape + Worley noise for detail erosion.
 */
export function generateCloudNoise(
  width: number = 512,
  height: number = 256,
  seed: number = 42
): Float32Array {
  const data = new Float32Array(width * height);

  // Pre-offset coordinates by seed for variation
  const ox = seed * 3.71;
  const oy = seed * 2.39;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 8; // 8 tiles across
      const v = (j / height) * 4; // 4 tiles vertically

      // Layer 1: Base shape — low-frequency Perlin fBm
      const base = fbm(u + ox, v + oy, 5, 2.0, 0.5);

      // Layer 2: Worley noise for cloud cell structure
      const worley = 1.0 - worleyNoise(u * 1.5 + ox, v * 1.5 + oy);

      // Layer 3: High-frequency detail
      const detail = fbm(u * 4 + ox * 2, v * 4 + oy * 2, 3, 2.5, 0.45);

      // Combine: Perlin base + Worley structure, eroded by detail
      let cloud = base * 0.5 + worley * 0.35 + detail * 0.15;

      // Remap with threshold — creates hard cloud edges
      // Values below threshold become 0 (clear sky)
      const threshold = 0.38;
      const transition = 0.15;
      cloud = smoothstep((cloud - threshold) / transition);

      // Latitude-based density — more clouds near equator, fewer at poles
      const latFactor = 1.0 - Math.pow(Math.abs(j / height - 0.5) * 2, 2) * 0.3;
      cloud *= latFactor;

      data[j * width + i] = Math.max(0, Math.min(1, cloud));
    }
  }

  return data;
}

/**
 * Generate a height variation noise grid.
 *
 * Values control how "tall" the cloud column is at each point:
 * - 0 = flat stratus (thin layer)
 * - 1 = tall cumulonimbus (deep convection)
 */
export function generateHeightNoise(
  width: number = 512,
  height: number = 256,
  seed: number = 77
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 1.13;
  const oy = seed * 3.47;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6;
      const v = (j / height) * 3;

      // Low-frequency noise for large convection regions
      const convection = fbm(u + ox, v + oy, 3, 2.0, 0.55);

      // Medium frequency for cloud type patches
      const patch = valueNoise(u * 2 + ox, v * 2 + oy);

      const heightVar = convection * 0.6 + patch * 0.4;

      data[j * width + i] = Math.max(0, Math.min(1, heightVar));
    }
  }

  return data;
}

/**
 * Render noise to a canvas for debugging.
 */
export function noiseToCanvas(noise: Float32Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);

  for (let i = 0; i < noise.length; i++) {
    const v = Math.round(noise[i] * 255);
    const idx = i * 4;
    imageData.data[idx] = v;
    imageData.data[idx + 1] = v;
    imageData.data[idx + 2] = v;
    imageData.data[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
