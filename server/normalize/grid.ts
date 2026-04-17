/**
 * Grid normalization — Converts raw forecast data into uniform lat-lon grids.
 */

/**
 * Interpolate from native grid to uniform lat-lon grid.
 *
 * GFS data comes in various resolutions (0.25°, 0.5°, 1.0°).
 * We normalize everything to a common grid for consistent texture mapping.
 *
 * @param rawData - Raw grid data from GFS
 * @param srcWidth - Source grid width
 * @param srcHeight - Source grid height
 * @param dstWidth - Target grid width (e.g., 360 for 1° resolution)
 * @param dstHeight - Target grid height (e.g., 180)
 */
export function normalizeToLatLon(
  rawData: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Float32Array {
  const result = new Float32Array(dstWidth * dstHeight);

  for (let j = 0; j < dstHeight; j++) {
    for (let i = 0; i < dstWidth; i++) {
      // Bilinear interpolation
      const srcX = (i / dstWidth) * (srcWidth - 1);
      const srcY = (j / dstHeight) * (srcHeight - 1);

      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, srcWidth - 1);
      const y1 = Math.min(y0 + 1, srcHeight - 1);

      const fx = srcX - x0;
      const fy = srcY - y0;

      const v00 = rawData[y0 * srcWidth + x0];
      const v10 = rawData[y0 * srcWidth + x1];
      const v01 = rawData[y1 * srcWidth + x0];
      const v11 = rawData[y1 * srcWidth + x1];

      result[j * dstWidth + i] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy;
    }
  }

  return result;
}

/**
 * Pack multiple fields into an RGBA texture.
 *
 * Common packing:
 *  - RGBA = [u_wind, v_wind, humidity, cloud_fraction]
 *  - RGBA = [temp, pressure, unused, unused]
 */
export function packToRGBA(
  fields: Float32Array[],
  width: number,
  height: number
): Float32Array {
  const channels = Math.min(fields.length, 4);
  const result = new Float32Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 4; c++) {
      result[i * 4 + c] = c < channels ? fields[c][i] : 0;
    }
  }

  return result;
}

/**
 * Apply unit conversions for common meteorological variables.
 */
export const UnitConversions = {
  /** Kelvin to Celsius */
  kToC: (k: number) => k - 273.15,

  /** Pa to hPa (millibars) */
  paToHpa: (pa: number) => pa / 100,

  /** m/s to knots */
  msToKnots: (ms: number) => ms * 1.944,

  /** Fraction (0-1) to percentage */
  fractionToPercent: (f: number) => f * 100,
};
