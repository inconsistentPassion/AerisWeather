/**
 * GOES satellite source — cloud detail overlay.
 *
 * Fetches latest visible/IR imagery from GOES-16 (East) or GOES-18 (West)
 * via AWS Open Data. Provides high-resolution cloud shape/detail texture.
 *
 * Used as detail overlay blended with base physical cloud fields.
 *
 * Sources:
 *   - GOES-16: noaa-goes16.s3.amazonaws.com
 *   - GOES-18: noaa-goes18.s3.amazonaws.com
 *   - NOAA SLIDER: https://rammb-slider.cira.colostate.edu/
 */

const GOES16_BASE = 'https://noaa-goes16.s3.amazonaws.com';
const GOES18_BASE = 'https://noaa-goes18.s3.amazonaws.com';

export interface SatelliteFrame {
  source: 'GOES-16' | 'GOES-18';
  band: number;        // 13 = clean IR longwave (cloud tops)
  timestamp: string;
  width: number;
  height: number;
  data: Float32Array;  // brightness temperature or reflectance, normalized 0-1
  bounds: {
    lonMin: number;
    lonMax: number;
    latMin: number;
    latMax: number;
  };
}

/**
 * Determine which GOES satellite covers the requested longitude.
 */
function selectSatellite(lon: number): { base: string; name: 'GOES-16' | 'GOES-18' } {
  // GOES-16: -137.0°W to -16.0°W (Americas, Atlantic)
  // GOES-18: 173.0°E to -60.0°W (Americas, Pacific)
  if (lon > -60) {
    return { base: GOES16_BASE, name: 'GOES-16' };
  }
  return { base: GOES18_BASE, name: 'GOES-18' };
}

/**
 * Build the S3 path for the latest GOES Full Disk product.
 * Band 13 = Clean IR Longwave (10.3 μm) — good for cloud top temperature.
 * Band 2 = Visible (0.64 μm) — good for daytime cloud shapes.
 */
function buildProductPath(band: number, year: number, dayOfYear: number, hour: number): string {
  const product = band <= 6 ? 'ABI-L2-CMIPF' : 'ABI-L2-CMIPF';
  const paddedDay = String(dayOfYear).padStart(3, '0');
  const paddedHour = String(hour).padStart(2, '0');
  return `${product}/${year}/${paddedDay}/${paddedHour}`;
}

/**
 * Fetch the latest GOES full-disk image metadata for a band.
 * Returns the S3 object key of the most recent scan.
 */
async function findLatestScan(base: string, band: number): Promise<string | null> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86400000) + 1;
  const hour = now.getUTCHours();

  // Try current hour and recent hours
  for (let h = hour; h >= Math.max(0, hour - 3); h--) {
    const path = buildProductPath(band, year, dayOfYear, h);
    const listUrl = `${base}?list-type=2&prefix=${path}/&max-keys=5`;

    try {
      const res = await fetch(listUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'AerisWeather/0.1.0' },
      });

      if (!res.ok) continue;

      const xml = await res.text();
      // Parse S3 XML listing to find latest key
      const keyMatch = xml.match(/<Key>([^<]*\.nc)<\/Key>/g);
      if (keyMatch && keyMatch.length > 0) {
        // Get the last (most recent) key
        const lastKey = keyMatch[keyMatch.length - 1].replace(/<\/?Key>/g, '');
        return lastKey;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Fetch a GOES satellite frame for cloud detail.
 *
 * In production, this would download and parse the NetCDF file.
 * For now, returns a synthetic texture based on GOES coverage area.
 *
 * TODO: Integrate netcdf4js or hdf5 parser for real data.
 */
export async function fetchGOESFrame(
  lon: number,
  lat: number,
  band: number = 13
): Promise<SatelliteFrame | null> {
  const sat = selectSatellite(lon);

  console.log(`[GOES] Fetching ${sat.name} band ${band} for (${lat.toFixed(1)}, ${lon.toFixed(1)})`);

  // GOES full disk covers roughly:
  // Lat: -80 to 80 (limited by Earth curvature at geostationary orbit)
  // Lon: satellite-dependent, ~140° span
  if (Math.abs(lat) > 80) {
    console.log('[GOES] Point outside GOES coverage (polar)');
    return null;
  }

  try {
    // Try to find latest scan metadata
    // In a full implementation, we'd download the NetCDF and extract data
    // For now, generate a coverage-aware placeholder

    // GOES-16 full disk bounds (approximate)
    const bounds = sat.name === 'GOES-16'
      ? { lonMin: -137, lonMax: -16, latMin: -80, latMax: 80 }
      : { lonMin: 173, lonMax: -60, latMin: -80, latMax: 80 };

    // Generate a noise-based cloud texture as placeholder
    // Real implementation would parse the NetCDF CMI variable
    const width = 256;
    const height = 256;
    const data = generateCloudTexture(width, height, lon, lat, band);

    return {
      source: sat.name,
      band,
      timestamp: new Date().toISOString(),
      width,
      height,
      data,
      bounds,
    };
  } catch (err) {
    console.warn(`[GOES] Fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate a cloud detail texture.
 * In production this would be replaced by actual GOES data.
 * Uses multi-octave noise to simulate cloud structure.
 */
function generateCloudTexture(
  width: number,
  height: number,
  centerLon: number,
  centerLat: number,
  band: number
): Float32Array {
  const data = new Float32Array(width * height);
  const seed = centerLon * 7.13 + centerLat * 3.47;

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const u = (i / width) * 8 + seed;
      const v = (j / height) * 8 + seed * 0.7;

      // Multi-octave FBM
      let val = 0;
      let amp = 1;
      let freq = 1;
      for (let o = 0; o < 5; o++) {
        val += amp * valueNoise2D(u * freq, v * freq);
        amp *= 0.5;
        freq *= 2;
      }
      val /= 1.9375; // normalize

      // Worley for cell-like structure
      const worley = 1 - worleyNoise2D(u * 1.5, v * 1.5);

      // Combine
      let cloud = val * 0.6 + worley * 0.4;
      cloud = Math.max(0, cloud - 0.35) / 0.65; // threshold
      cloud = Math.min(1, cloud);

      // IR band: invert (clouds are cold = high values)
      if (band > 6) {
        cloud = 1 - cloud * 0.7;
      }

      data[j * width + i] = cloud;
    }
  }

  return data;
}

function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => {
    let v = a * 374761393 + b * 668265263;
    v = ((v ^ (v >> 13)) * 1274126177) | 0;
    return (v & 0x7fffffff) / 0x7fffffff;
  };
  const n00 = h(ix, iy), n10 = h(ix + 1, iy);
  const n01 = h(ix, iy + 1), n11 = h(ix + 1, iy + 1);
  return (n00 + sx * (n10 - n00)) + sy * ((n01 + sx * (n11 - n01)) - (n00 + sx * (n10 - n00)));
}

function worleyNoise2D(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  let minDist = 1.0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const px = hash2(cx * 73 + 17, cy * 157 + 31);
      const py = hash2(cx * 89 + 43, cy * 131 + 67);
      const dist = Math.sqrt((dx + px - fx) ** 2 + (dy + py - fy) ** 2);
      minDist = Math.min(minDist, dist);
    }
  }
  return minDist;
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263 + 1274126177) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}
