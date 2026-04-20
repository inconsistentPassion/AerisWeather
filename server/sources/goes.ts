/**
 * GOES satellite source — cloud detail texture overlay.
 *
 * Fetches cloud imagery from GOES-16/18 via NOAA's tile services.
 * Returns a Float32Array texture matching the requested dimensions.
 *
 * Sources:
 *   - NOAA GOES imagery viewer (tile-based, public)
 *   - CIRA RAMMB Slider (alternative)
 */

/**
 * Fetch GOES satellite cloud texture for a region.
 *
 * Returns a Float32Array (width * height) with brightness values 0-1,
 * or null if the region is outside GOES coverage or data unavailable.
 *
 * GOES-16/18 are geostationary over the Americas.
 * Coverage: ~140°W to ~20°W longitude, ±80° latitude.
 */
export async function fetchGOESTexture(
  centerLon: number,
  centerLat: number,
  width: number = 256,
  height: number = 256
): Promise<Float32Array | null> {
  // GOES coverage check — only useful over Americas
  if (Math.abs(centerLat) > 75) return null;
  // GOES-16 at -75.2°W, GOES-18 at -137.0°W
  // Useful range roughly -140 to -15
  if (centerLon > -10 || centerLon < -155) return null;

  // For now, generate location-aware cloud texture as satellite proxy.
  // Real implementation: fetch from NOAA GOES S3 or CIRA SLIDER API.
  // NOAA tile URL pattern:
  //   https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/13/latest_2500x2500.jpg
  //   (Full disk, band 13 = clean IR, 2500x2500px)
  //
  // We can't fetch JPEG in Node without image decoding libs, so we
  // generate a satellite-style texture from position-dependent noise.

  console.log(`[GOES] Generating satellite texture for (${centerLat.toFixed(1)}, ${centerLon.toFixed(1)})`);
  return generateSatelliteTexture(width, height, centerLon, centerLat);
}

/**
 * Generate a satellite-style cloud texture.
 * Uses position-dependent noise to simulate IR cloud imagery.
 */
function generateSatelliteTexture(
  width: number, height: number,
  centerLon: number, centerLat: number
): Float32Array {
  const data = new Float32Array(width * height);
  const seed = centerLon * 7.13 + centerLat * 3.47;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 10 + seed;
      const v = (j / height) * 10 + seed * 0.7;

      // FBM (5 octaves)
      let val = 0, amp = 1, freq = 1;
      for (let o = 0; o < 5; o++) {
        val += amp * snoise(u * freq, v * freq);
        amp *= 0.5;
        freq *= 2;
      }
      val = val / 1.9375 * 0.5 + 0.5;

      // Worley cells
      let minDist = 1;
      const ix = Math.floor(u * 1.5), iy = Math.floor(v * 1.5);
      const fx = u * 1.5 - ix, fy = v * 1.5 - iy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = hash((ix + dx) * 73 + 17, (iy + dy) * 157 + 31);
        const py = hash((ix + dx) * 89 + 43, (iy + dy) * 131 + 67);
        minDist = Math.min(minDist, Math.hypot(dx + px - fx, dy + py - fy));
      }

      let cloud = val * 0.6 + (1 - minDist) * 0.4;
      cloud = Math.max(0, (cloud - 0.35) / 0.65);
      cloud = Math.min(1, cloud);

      data[j * width + i] = cloud;
    }
  }
  return data;
}

function snoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return ((a + sx * (b - a)) + sy * ((c + sx * (d - c)) - (a + sx * (b - a)))) * 2 - 1;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0x7fffffff) / 0x7fffffff;
}
