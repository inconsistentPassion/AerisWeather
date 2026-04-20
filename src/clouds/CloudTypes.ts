/**
 * CloudTypes — EVE-inspired cloud type system.
 *
 * EVE uses a "Cloud Type Map" (2D texture) to place different cloud types
 * at different locations. Each type has its own:
 *   - Altitude range (min/max)
 *   - Coverage curve (vertical profile — shape)
 *   - Density curve (vertical density variation)
 *   - Edge hardness
 *   - Noise parameters
 *   - Color tint
 *
 * We adapt this to work with real weather data:
 *   - Cloud type is determined by weather conditions (temp, humidity, lat)
 *   - Vertical profile is applied during point placement
 *   - Per-type noise/shaping is applied in the fragment shader
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface CloudTypeConfig {
  id: string;
  name: string;

  // Altitude
  minAlt: number;  // meters
  maxAlt: number;  // meters
  typicalAlt: number; // meters, used for band center

  // Visual
  color: [number, number, number];  // RGB 0-1
  opacityRange: [number, number];   // [min, max] alpha
  sizeRange: [number, number];      // point size in meters
  density: number;                  // points per grid cell

  // Noise shaping (passed to shader as uniforms)
  noiseScale: number;       // FBM tiling
  edgeHardness: number;     // 0-1, controls edge sharpness (EVE concept)
  erosionDepth: number;     // 0-1, how deep noise erodes into cloud
  worleySpherical: number;  // 0-1, makes Worley look billowy (EVE Release 5)

  // Vertical profile (EVE's CoverageCurve)
  // Array of [heightFraction, densityMultiplier] pairs
  // heightFraction: 0 = cloud base, 1 = cloud top
  // densityMultiplier: 0 = no clouds, 1 = full density
  coverageCurve: [number, number][];

  // Data weight: how much of the global cloudFraction maps to this type
  dataWeight: number;
}

// ── Preset Cloud Types (EVE-style definitions) ─────────────────────────

export const CLOUD_TYPES: Record<string, CloudTypeConfig> = {
  cumulus: {
    id: 'cumulus',
    name: 'Cumulus',
    minAlt: 500, maxAlt: 2500, typicalAlt: 1200,
    color: [0.97, 0.97, 0.99],
    opacityRange: [0.45, 0.85],
    sizeRange: [10, 28],
    density: 7,
    noiseScale: 1.0,
    edgeHardness: 0.7,
    erosionDepth: 0.5,
    worleySpherical: 1.0,  // billowy, puffy
    // Bell curve: dense in middle, thin at base and top
    coverageCurve: [
      [0.0, 0.0],
      [0.15, 0.4],
      [0.4, 0.9],
      [0.6, 1.0],
      [0.8, 0.6],
      [1.0, 0.0],
    ],
    dataWeight: 0.45,
  },

  stratus: {
    id: 'stratus',
    name: 'Stratus',
    minAlt: 1500, maxAlt: 5000, typicalAlt: 3000,
    color: [0.85, 0.87, 0.93],
    opacityRange: [0.25, 0.55],
    sizeRange: [14, 36],
    density: 4,
    noiseScale: 0.7,
    edgeHardness: 0.4,  // diffuse, soft edges
    erosionDepth: 0.3,
    worleySpherical: 0.3,  // flatter, more layered
    // Flat top, gradual base
    coverageCurve: [
      [0.0, 0.0],
      [0.1, 0.6],
      [0.3, 0.9],
      [0.9, 0.8],
      [1.0, 0.2],
    ],
    dataWeight: 0.25,
  },

  cirrus: {
    id: 'cirrus',
    name: 'Cirrus',
    minAlt: 6000, maxAlt: 12000, typicalAlt: 8500,
    color: [0.80, 0.84, 0.95],
    opacityRange: [0.10, 0.35],
    sizeRange: [16, 40],
    density: 2,
    noiseScale: 1.5,
    edgeHardness: 0.3,  // very wispy
    erosionDepth: 0.8,  // deep erosion = feathery
    worleySpherical: 0.0,  // not billowy, streaky
    // Thin sheet, concentrated in middle
    coverageCurve: [
      [0.0, 0.0],
      [0.2, 0.2],
      [0.5, 0.6],
      [0.8, 0.4],
      [1.0, 0.0],
    ],
    dataWeight: 0.08,
  },

  cumulonimbus: {
    id: 'cumulonimbus',
    name: 'Cumulonimbus',
    minAlt: 500, maxAlt: 12000, typicalAlt: 4000,
    color: [0.65, 0.68, 0.78],
    opacityRange: [0.50, 0.95],
    sizeRange: [16, 42],
    density: 6,
    noiseScale: 0.8,
    edgeHardness: 0.85,  // sharp, dramatic edges
    erosionDepth: 0.65,
    worleySpherical: 0.8,
    // Tall tower: thin base, massive middle, anvil top
    coverageCurve: [
      [0.0, 0.0],
      [0.05, 0.3],
      [0.15, 0.6],
      [0.3, 0.8],
      [0.5, 0.9],
      [0.7, 1.0],   // anvil base
      [0.85, 0.7],  // anvil spread
      [1.0, 0.2],   // wispy top
    ],
    dataWeight: 0.05,
  },

  fog: {
    id: 'fog',
    name: 'Fog / Stratus Low',
    minAlt: 0, maxAlt: 800, typicalAlt: 300,
    color: [0.90, 0.91, 0.94],
    opacityRange: [0.15, 0.40],
    sizeRange: [20, 50],
    density: 3,
    noiseScale: 0.5,
    edgeHardness: 0.15,  // extremely diffuse
    erosionDepth: 0.2,
    worleySpherical: 0.1,
    // Ground-hugging, fading upward
    coverageCurve: [
      [0.0, 1.0],
      [0.3, 0.8],
      [0.6, 0.4],
      [1.0, 0.0],
    ],
    dataWeight: 0.07,
  },

  altocumulus: {
    id: 'altocumulus',
    name: 'Altocumulus',
    minAlt: 2000, maxAlt: 6000, typicalAlt: 4000,
    color: [0.88, 0.90, 0.96],
    opacityRange: [0.20, 0.50],
    sizeRange: [10, 26],
    density: 3,
    noiseScale: 1.2,
    edgeHardness: 0.55,
    erosionDepth: 0.45,
    worleySpherical: 0.7,
    // Mid-level puffs
    coverageCurve: [
      [0.0, 0.0],
      [0.2, 0.3],
      [0.5, 0.8],
      [0.8, 0.5],
      [1.0, 0.0],
    ],
    dataWeight: 0.10,
  },
};

// All types in array form for iteration
export const ALL_CLOUD_TYPES = Object.values(CLOUD_TYPES);

// ── Coverage Curve Evaluation ──────────────────────────────────────────

/**
 * Evaluate an EVE-style coverage curve at a given height fraction.
 * Uses linear interpolation between control points.
 *
 * @param curve Array of [heightFraction, densityValue] control points
 * @param heightFrac 0 = cloud base, 1 = cloud top
 * @returns density multiplier (0-1)
 */
export function evalCoverageCurve(
  curve: [number, number][],
  heightFrac: number
): number {
  if (heightFrac <= curve[0][0]) return curve[0][1];
  if (heightFrac >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

  for (let i = 0; i < curve.length - 1; i++) {
    const [t0, v0] = curve[i];
    const [t1, v1] = curve[i + 1];
    if (heightFrac >= t0 && heightFrac <= t1) {
      const f = (heightFrac - t0) / (t1 - t0);
      // Smooth interpolation
      const sf = smoothstep(f);
      return v0 * (1 - sf) + v1 * sf;
    }
  }
  return 0;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// ── Weather-to-CloudType Mapping ───────────────────────────────────────

/**
 * Determine cloud type mix from weather parameters.
 * EVE uses a 2D "cloud type map" texture; we derive it from real data.
 *
 * Returns an array of {type, weight} indicating which cloud types
 * are present and their relative strength at this location.
 */
export function weatherToCloudTypes(
  temperature: number,    // °C
  humidity: number,       // 0-100
  cloudFraction: number,  // 0-1
  latitude: number        // degrees
): Array<{ type: CloudTypeConfig; weight: number }> {
  const absLat = Math.abs(latitude);
  const results: Array<{ type: CloudTypeConfig; weight: number }> = [];

  // Fog: near ground, high humidity, low temperature
  if (humidity > 85 && temperature < 15 && cloudFraction > 0.3) {
    results.push({ type: CLOUD_TYPES.fog, weight: 0.2 });
  }

  // Cirrus: high altitude, cold
  if (absLat > 20 && cloudFraction > 0.1) {
    results.push({ type: CLOUD_TYPES.cirrus, weight: 0.15 + (absLat / 90) * 0.1 });
  }

  // Cumulonimbus: tropical, high humidity, high cloud fraction
  if (absLat < 30 && humidity > 70 && cloudFraction > 0.6) {
    const stormWeight = (humidity / 100) * cloudFraction * 0.15;
    results.push({ type: CLOUD_TYPES.cumulonimbus, weight: stormWeight });
  }

  // Stratus: mid-latitude, moderate humidity
  if (absLat > 25 && humidity > 50 && cloudFraction > 0.2) {
    results.push({ type: CLOUD_TYPES.stratus, weight: 0.25 });
  }

  // Altocumulus: mid-latitude, moderate conditions
  if (absLat > 15 && absLat < 60 && cloudFraction > 0.15) {
    results.push({ type: CLOUD_TYPES.altocumulus, weight: 0.15 });
  }

  // Cumulus: default, warm, humid
  results.push({
    type: CLOUD_TYPES.cumulus,
    weight: 0.35 + (humidity / 100) * 0.15,
  });

  // Normalize weights
  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  if (totalWeight > 0) {
    for (const r of results) r.weight /= totalWeight;
  }

  return results;
}

// ── Shader Constants (exported for use in CloudPointLayer) ─────────────

/**
 * Get cloud type enum value for shader.
 * Must match the shader's cloudType switch.
 */
export function getCloudTypeIndex(typeId: string): number {
  switch (typeId) {
    case 'cumulus': return 0;
    case 'stratus': return 1;
    case 'cirrus': return 2;
    case 'cumulonimbus': return 3;
    case 'fog': return 4;
    case 'altocumulus': return 5;
    default: return 0;
  }
}
