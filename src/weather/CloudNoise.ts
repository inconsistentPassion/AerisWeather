/**
 * CloudNoise — Procedural noise textures for volumetric cloud shapes.
 *
 * Horizon: Zero Dawn style (simplified for web):
 * - Multi-octave Perlin-Worley noise
 * - Cloud-type-specific shaping (anvil, cumulus, cirrus)
 * - Height profiles for vertical extent control
 *
 * Output: Float32Array noise grids, values 0-1
 */

// ── Primitives ────────────────────────────────────────────────────────

function hash2D(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

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

function worleyNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  let minDist = 1.0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const px = hash2D(cx * 73 + 17, cy * 157 + 31);
      const py = hash2D(cx * 89 + 43, cy * 131 + 67);
      const dist = Math.sqrt((dx + px - fx) ** 2 + (dy + py - fy) ** 2);
      minDist = Math.min(minDist, dist);
    }
  }
  return minDist;
}

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

// ── Cloud Shape Noise ─────────────────────────────────────────────────

export function generateCloudNoise(
  width: number = 512,
  height: number = 256,
  seed: number = 42
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 3.71;
  const oy = seed * 2.39;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 8;
      const v = (j / height) * 4;

      const base = fbm(u + ox, v + oy, 5, 2.0, 0.5);
      const worley = 1.0 - worleyNoise(u * 1.5 + ox, v * 1.5 + oy);
      const detail = fbm(u * 4 + ox * 2, v * 4 + oy * 2, 3, 2.5, 0.45);

      let cloud = base * 0.5 + worley * 0.35 + detail * 0.15;

      const threshold = 0.38;
      const transition = 0.15;
      cloud = smoothstep((cloud - threshold) / transition);

      const latFactor = 1.0 - Math.pow(Math.abs(j / height - 0.5) * 2, 2) * 0.3;
      cloud *= latFactor;

      data[j * width + i] = Math.max(0, Math.min(1, cloud));
    }
  }
  return data;
}

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
      const convection = fbm(u + ox, v + oy, 3, 2.0, 0.55);
      const patch = valueNoise(u * 2 + ox, v * 2 + oy);
      const heightVar = convection * 0.6 + patch * 0.4;
      data[j * width + i] = Math.max(0, Math.min(1, heightVar));
    }
  }
  return data;
}

// ── Per-band noise for storm anvil / cumulus / cirrus ─────────────────

/**
 * Generate storm intensity noise — controls where cumulonimbus anvils form.
 * High values = deep convection → tall clouds with anvil tops.
 */
export function generateStormNoise(
  width: number = 256,
  height: number = 128,
  seed: number = 99
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 5.31;
  const oy = seed * 2.77;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6;
      const v = (j / height) * 3;

      // Large-scale convection cells
      const convection = fbm(u + ox, v + oy, 3, 2.0, 0.55);
      // Medium-scale updrafts
      const updraft = valueNoise(u * 2.5 + ox * 1.3, v * 2.5 + oy * 0.7);
      // Combine with threshold — storms are rare, clustered
      let storm = convection * 0.55 + updraft * 0.45;
      storm = smoothstep((storm - 0.55) / 0.2);

      // Tropical preference (more storms near equator)
      const lat = Math.abs(j / height - 0.5) * 2;
      storm *= Math.max(0, 1.0 - lat * lat * 1.5);

      data[j * width + i] = Math.max(0, Math.min(1, storm));
    }
  }
  return data;
}

// ── Debug ─────────────────────────────────────────────────────────────

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
