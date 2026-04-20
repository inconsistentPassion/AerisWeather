/**
 * CloudNoise — EVE-inspired procedural noise for volumetric cloud rendering.
 *
 * Adapted from LGhassen's EVE approach:
 *   - Perlin-Worley hybrid FBM (billowy cumulus shapes)
 *   - Curl noise for wispier, flowy edges
 *   - Worley F1/F2 for erosion detail
 *   - 3D coordinate support (x, y, altitude fraction)
 *   - Cloud-type-specific shaping
 *
 * Used by CloudPointLayer for:
 *   - Fragment shader: per-sprite noise shaping
 *   - CPU placement: density modulation per altitude band
 */

// ── Primitives ─────────────────────────────────────────────────────────

function hash2D(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function hash3D(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// ── Perlin Noise ───────────────────────────────────────────────────────

function perlinNoise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = smoothstep(fx), sy = smoothstep(fy), sz = smoothstep(fz);

  // Gradient dot products (simplified Perlin)
  const grad = (gx: number, gy: number, gz: number, px: number, py: number, pz: number): number => {
    const h = hash3D(gx + 43, gy + 17, gz + 67);
    // Select gradient direction from hash
    const gi = Math.floor(h * 12);
    const dx = px - gx, dy = py - gy, dz = pz - gz;
    // Pre-computed gradient table (12 directions)
    const grads = [
      [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
      [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
      [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
    ];
    const g = grads[gi % 12];
    return dx * g[0] + dy * g[1] + dz * g[2];
  };

  const a000 = grad(ix, iy, iz, fx, fy, fz);
  const a100 = grad(ix+1, iy, iz, fx-1, fy, fz);
  const a010 = grad(ix, iy+1, iz, fx, fy-1, fz);
  const a110 = grad(ix+1, iy+1, iz, fx-1, fy-1, fz);
  const a001 = grad(ix, iy, iz+1, fx, fy, fz-1);
  const a101 = grad(ix+1, iy, iz+1, fx-1, fy, fz-1);
  const a011 = grad(ix, iy+1, iz+1, fx, fy-1, fz-1);
  const a111 = grad(ix+1, iy+1, iz+1, fx-1, fy-1, fz-1);

  const x00 = a000 * (1-sx) + a100 * sx;
  const x10 = a010 * (1-sx) + a110 * sx;
  const x01 = a001 * (1-sx) + a101 * sx;
  const x11 = a011 * (1-sx) + a111 * sx;

  const y0 = x00 * (1-sy) + x10 * sy;
  const y1 = x01 * (1-sy) + x11 * sy;

  return (y0 * (1-sz) + y1 * sz) * 0.5 + 0.5; // remap to 0-1
}

// ── Value Noise ────────────────────────────────────────────────────────

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smoothstep(x - ix), fy = smoothstep(y - iy);
  const a = hash2D(ix, iy);
  const b = hash2D(ix + 1, iy);
  const c = hash2D(ix, iy + 1);
  const d = hash2D(ix + 1, iy + 1);
  return a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
}

function valueNoise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smoothstep(x - ix), fy = smoothstep(y - iy), fz = smoothstep(z - iz);

  const c000 = hash3D(ix, iy, iz);
  const c100 = hash3D(ix+1, iy, iz);
  const c010 = hash3D(ix, iy+1, iz);
  const c110 = hash3D(ix+1, iy+1, iz);
  const c001 = hash3D(ix, iy, iz+1);
  const c101 = hash3D(ix+1, iy, iz+1);
  const c011 = hash3D(ix, iy+1, iz+1);
  const c111 = hash3D(ix+1, iy+1, iz+1);

  const x00 = c000*(1-fx) + c100*fx;
  const x10 = c010*(1-fx) + c110*fx;
  const x01 = c001*(1-fx) + c101*fx;
  const x11 = c011*(1-fx) + c111*fx;

  return (x00*(1-fy) + x10*fy)*(1-fz) + (x01*(1-fy) + x11*fy)*fz;
}

// ── Worley Noise (EVE-style: F1, F2, cellular) ────────────────────────

interface WorleyResult {
  f1: number;   // distance to nearest point
  f2: number;   // distance to second nearest
  cell: number; // id of nearest cell
}

function worleyNoise(x: number, y: number): WorleyResult {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let f1 = 10, f2 = 10, cell = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      // Deterministic feature point in each cell
      const px = hash2D(cx * 73 + 17, cy * 157 + 31);
      const py = hash2D(cx * 89 + 43, cy * 131 + 67);
      const dist = Math.sqrt((dx + px - fx) ** 2 + (dy + py - fy) ** 2);
      if (dist < f1) {
        f2 = f1;
        f1 = dist;
        cell = cy * 1000 + cx;
      } else if (dist < f2) {
        f2 = dist;
      }
    }
  }
  return { f1: Math.min(f1, 1), f2: Math.min(f2, 1), cell };
}

function worleyNoise3D(x: number, y: number, z: number): WorleyResult {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  let f1 = 10, f2 = 10, cell = 0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix+dx, cy = iy+dy, cz = iz+dz;
        const px = hash3D(cx*73+17, cy*157+31, cz*89+43);
        const py = hash3D(cx*97+53, cy*131+67, cz*113+79);
        const pz = hash3D(cx*61+37, cy*179+97, cz*71+59);
        const dist = Math.sqrt(
          (dx+px-fx)**2 + (dy+py-fy)**2 + (dz+pz-fz)**2
        );
        if (dist < f1) { f2 = f1; f1 = dist; cell = cz*1000000+cy*1000+cx; }
        else if (dist < f2) { f2 = dist; }
      }
    }
  }
  return { f1: Math.min(f1, 1.73), f2: Math.min(f2, 1.73), cell };
}

// ── FBM (Fractal Brownian Motion) ──────────────────────────────────────

function fbm2D(
  x: number, y: number,
  octaves: number,
  lacunarity: number = 2.0,
  gain: number = 0.5
): number {
  let value = 0, amplitude = 1, frequency = 1, maxVal = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, y * frequency);
    maxVal += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return value / maxVal;
}

function fbm3D(
  x: number, y: number, z: number,
  octaves: number,
  lacunarity: number = 2.0,
  gain: number = 0.5
): number {
  let value = 0, amplitude = 1, frequency = 1, maxVal = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * perlinNoise3D(x * frequency, y * frequency, z * frequency);
    maxVal += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return value / maxVal;
}

// ── Perlin-Worley Hybrid (EVE's core noise) ────────────────────────────

/**
 * Perlin-Worley hybrid: smooth Perlin base + billowy Worley detail.
 * This is the primary cloud shape noise used by EVE.
 *
 * @param persistence Controls how much Worley subtracts from Perlin
 *   - 0.0 = pure Perlin (smooth)
 *   - 0.5 = balanced hybrid
 *   - 1.0 = heavy Worley erosion (very detailed)
 */
export function perlinWorleyHybrid(
  x: number, y: number,
  octaves: number = 5,
  persistence: number = 0.5
): number {
  // Perlin FBM base — smooth cloud mass
  const perlin = fbm2D(x, y, octaves, 2.0, 0.5);

  // Worley — cellular detail (1 - F1 creates "inverted" cells = puffy shapes)
  const worley = 1.0 - worleyNoise(x * 1.5, y * 1.5).f1;

  // Detail octave for small-scale variation
  const detail = fbm2D(x * 4, y * 4, 3, 2.5, 0.45);

  // EVE-style hybrid: Perlin base shaped by Worley
  return perlin * (1.0 - persistence * 0.5) + worley * persistence * 0.35 + detail * 0.15;
}

// ── Curl Noise (EVE's wispy edge displacement) ─────────────────────────

/**
 * Curl noise: creates divergence-free displacement vectors.
 * In EVE this warps the density field for wispy, flowing cloud edges.
 *
 * Returns (dx, dy) displacement offset.
 */
export function curlNoise(
  x: number, y: number,
  octaves: number = 3,
  strength: number = 1.0
): { dx: number; dy: number } {
  const eps = 0.01;

  // Finite differences of a potential field → curl
  const n_x0 = fbm2D(x - eps, y, octaves);
  const n_x1 = fbm2D(x + eps, y, octaves);
  const n_y0 = fbm2D(x, y - eps, octaves);
  const n_y1 = fbm2D(x, y + eps, octaves);

  // curl = (dF/dy, -dF/dx)
  const dx = (n_y1 - n_y0) / (2 * eps) * strength;
  const dy = -(n_x1 - n_x0) / (2 * eps) * strength;

  return { dx, dy };
}

// ── Cloud Shape Generation ─────────────────────────────────────────────

/**
 * Generate 2D cloud coverage map from Perlin-Worley noise.
 * EVE-style: threshold + smoothstep for natural cloud boundaries.
 */
export function generateCloudNoise(
  width: number = 512,
  height: number = 256,
  seed: number = 42,
  persistence: number = 0.5
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 3.71, oy = seed * 2.39;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 8;
      const v = (j / height) * 4;

      let cloud = perlinWorleyHybrid(u + ox, v + oy, 5, persistence);

      // Threshold: EVE uses this to control how much area is covered
      const threshold = 0.38;
      const transition = 0.15;
      cloud = smoothstep((cloud - threshold) / transition);

      // Latitude factor: more clouds near equator (ITCZ), less at poles
      const latFrac = Math.abs(j / height - 0.5) * 2;
      const latFactor = 1.0 - latFrac * latFrac * 0.3;
      cloud *= latFactor;

      // Storm tracks: bands at ~30° and ~60° latitude (Ferrel cell)
      const stormBelt30 = Math.exp(-Math.pow((latFrac - 0.33) * 8, 2)) * 0.15;
      const stormBelt60 = Math.exp(-Math.pow((latFrac - 0.67) * 6, 2)) * 0.1;
      cloud += stormBelt30 + stormBelt60;

      data[j * width + i] = Math.max(0, Math.min(1, cloud));
    }
  }
  return data;
}

/**
 * Generate height variation noise — controls which altitude bands are active.
 * EVE uses this to decide how "tall" clouds are at each location.
 */
export function generateHeightNoise(
  width: number = 512, height: number = 256, seed: number = 77
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 1.13, oy = seed * 3.47;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6, v = (j / height) * 3;
      const convection = fbm2D(u + ox, v + oy, 3, 2.0, 0.55);
      const patch = valueNoise(u * 2 + ox, v * 2 + oy);
      data[j * width + i] = Math.max(0, Math.min(1, convection * 0.6 + patch * 0.4));
    }
  }
  return data;
}

/**
 * Generate storm intensity noise — controls where cumulonimbus anvils form.
 * High values = deep convection → tall clouds with anvil tops.
 * EVE uses this for towering cumulonimbus formations.
 */
export function generateStormNoise(
  width: number = 256, height: number = 128, seed: number = 99
): Float32Array {
  const data = new Float32Array(width * height);
  const ox = seed * 5.31, oy = seed * 2.77;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6, v = (j / height) * 3;
      const convection = fbm2D(u + ox, v + oy, 3, 2.0, 0.55);
      const updraft = valueNoise(u * 2.5 + ox * 1.3, v * 2.5 + oy * 0.7);
      let storm = convection * 0.55 + updraft * 0.45;
      storm = smoothstep((storm - 0.55) / 0.2);
      // Tropical preference
      const lat = Math.abs(j / height - 0.5) * 2;
      storm *= Math.max(0, 1.0 - lat * lat * 1.5);
      data[j * width + i] = Math.max(0, Math.min(1, storm));
    }
  }
  return data;
}

/**
 * Generate curl noise displacement map for wind-driven cloud animation.
 * EVE uses flowmaps; we use curl noise as a cheaper alternative.
 */
export function generateCurlMap(
  width: number = 256, height: number = 128,
  seed: number = 55, strength: number = 0.3
): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(width * height);
  const dy = new Float32Array(width * height);

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 6 + seed * 0.1;
      const v = (j / height) * 3 + seed * 0.07;
      const c = curlNoise(u, v, 3, strength);
      dx[j * width + i] = c.dx;
      dy[j * width + i] = c.dy;
    }
  }
  return { dx, dy };
}

// ── Debug ──────────────────────────────────────────────────────────────

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
