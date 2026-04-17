/**
 * Noise3D — Proper Perlin-Worley FBM for volumetric clouds.
 *
 * Generates a 3D noise texture that can be baked to a binary file
 * or generated at runtime.
 *
 * The noise is a combination of:
 *   - Perlin noise (smooth base)
 *   - Worley noise (cellular structure)
 *   - FBM (fractal brownian motion for detail)
 */

// --- Perlin noise helpers ---

function hash(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function perlin3d(x: number, y: number, z: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const zi = Math.floor(z) & 255;

  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const zf = z - Math.floor(z);

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  // Hash corners
  const aaa = hash(xi, yi, zi);
  const aba = hash(xi, yi + 1, zi);
  const aab = hash(xi, yi, zi + 1);
  const abb = hash(xi, yi + 1, zi + 1);
  const baa = hash(xi + 1, yi, zi);
  const bba = hash(xi + 1, yi + 1, zi);
  const bab = hash(xi + 1, yi, zi + 1);
  const bbb = hash(xi + 1, yi + 1, zi + 1);

  // Interpolate
  const x1 = lerp(aaa, baa, u);
  const x2 = lerp(aba, bba, u);
  const x3 = lerp(aab, bab, u);
  const x4 = lerp(abb, bbb, u);

  const y1 = lerp(x1, x2, v);
  const y2 = lerp(x3, x4, v);

  return lerp(y1, y2, w);
}

// --- Worley (cellular) noise ---

function worley3d(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);

  let minDist = 1.0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;

        // Random point in this cell
        const px = cx + hash(cx * 17, cy * 31, cz * 47);
        const py = cy + hash(cx * 53, cy * 71, cz * 89);
        const pz = cz + hash(cx * 97, cy * 113, cz * 131);

        const dist = Math.sqrt(
          (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2
        );

        minDist = Math.min(minDist, dist);
      }
    }
  }

  return Math.min(1.0, minDist);
}

// --- FBM (Fractal Brownian Motion) ---

function perlinFBM(x: number, y: number, z: number, octaves: number = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1.0;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += perlin3d(x * frequency, y * frequency, z * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }

  return value / maxValue;
}

function worleyFBM(x: number, y: number, z: number, octaves: number = 3): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1.0;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += worley3d(x * frequency, y * frequency, z * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }

  return value / maxValue;
}

// --- Main export: Generate Perlin-Worley noise ---

/**
 * Generate a 3D Perlin-Worley noise texture.
 *
 * Returns a Float32Array of size³ values in [0, 1].
 * The noise combines Perlin FBM (detail) with Worley (cellular structure)
 * to produce cloud-like formations.
 *
 * Channels in the resulting texture:
 *   R = Perlin-Worley (combined)
 *   G = Perlin FBM (detail)
 *   B = Worley FBM (erosion)
 *   A = height gradient
 *
 * For a single-channel 3D texture, we store the combined value.
 */
export function generatePerlinWorley3D(size: number): Float32Array {
  const data = new Float32Array(size * size * size);

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = z * size * size + y * size + x;

        const nx = x / size;
        const ny = y / size;
        const nz = z / size;

        // Perlin FBM — smooth detail
        const perlin = perlinFBM(nx * 4, ny * 4, nz * 4, 4);

        // Worley FBM — cellular structure
        const worley = worleyFBM(nx * 4, ny * 4, nz * 4, 3);

        // Combine: Perlin provides base shape, Worley erodes edges
        // This produces the classic Perlin-Worley pattern used for clouds
        let combined = perlin * 0.7 + (1.0 - worley) * 0.3;

        // Remap for better cloud distribution
        combined = Math.max(0, combined - 0.3) / 0.7;

        data[idx] = Math.max(0, Math.min(1, combined));
      }
    }
  }

  return data;
}

/**
 * Generate a multi-channel 3D noise texture for richer cloud detail.
 * Returns 4 channels: [perlinWorley, perlinFBM, worleyFBM, heightGradient]
 */
export function generateNoise3DChannel(size: number): Float32Array {
  const data = new Float32Array(size * size * size * 4);

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const voxelIdx = z * size * size + y * size + x;
        const idx = voxelIdx * 4;

        const nx = x / size;
        const ny = y / size;
        const nz = z / size;

        // R: Perlin-Worley combined
        const perlin = perlinFBM(nx * 4, ny * 4, nz * 4, 4);
        const worley = worleyFBM(nx * 4, ny * 4, nz * 4, 3);
        let combined = perlin * 0.7 + (1.0 - worley) * 0.3;
        combined = Math.max(0, combined - 0.3) / 0.7;
        data[idx] = Math.max(0, Math.min(1, combined));

        // G: Detail Perlin FBM (higher frequency)
        const detail = perlinFBM(nx * 8, ny * 8, nz * 8, 3);
        data[idx + 1] = Math.max(0, Math.min(1, detail));

        // B: Worley for erosion
        const worleyDetail = worleyFBM(nx * 6, ny * 6, nz * 6, 2);
        data[idx + 2] = Math.max(0, Math.min(1, worleyDetail));

        // A: Height gradient (0 at bottom, 1 at top)
        data[idx + 3] = ny;
      }
    }
  }

  return data;
}
