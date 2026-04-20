/**
 * CloudPointLayer — Game-quality volumetric cloud visualization.
 *
 * Renders cloud puffs as billboard point sprites with procedural
 * Perlin-Worley noise in the fragment shader. Supports:
 * - Storm anvils (cumulonimbus — wide flat tops, narrow bases)
 * - Cumulus puffs (bumpy, bright, cauliflower-like)
 * - Cirrus wisps (thin, stretched, translucent)
 *
 * Data-driven: cloud coverage, altitude, and storm intensity come
 * from WeatherManager (Open-Meteo / GFS).
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';
import { generateCloudNoise, generateHeightNoise, generateStormNoise } from '../weather/CloudNoise';

// ── Configuration ─────────────────────────────────────────────────────

interface BandConfig {
  id: string;
  /** Base altitude in meters */
  altitude: number;
  /** Altitude spread (± meters) */
  altitudeSpread: number;
  /** Tint color [r, g, b] 0-1 */
  color: [number, number, number];
  /** Point size range in pixels */
  sizeRange: [number, number];
  /** Opacity range */
  opacityRange: [number, number];
  /** Maximum particles */
  maxPoints: number;
  /** Points per grid cell multiplier */
  density: number;
  /** Cloud type: affects fragment shader shape */
  cloudType: 'cumulus' | 'stratus' | 'cirrus' | 'anvil';
}

const BANDS: BandConfig[] = [
  {
    id: 'low',
    altitude: 800,
    altitudeSpread: 1200,
    color: [0.97, 0.97, 0.99],
    sizeRange: [10, 32],
    opacityRange: [0.45, 0.85],
    maxPoints: 80000,
    density: 6,
    cloudType: 'cumulus',
  },
  {
    id: 'low-anvil',
    altitude: 1500,
    altitudeSpread: 2000,
    color: [0.90, 0.91, 0.95],
    sizeRange: [16, 48],
    opacityRange: [0.5, 0.9],
    maxPoints: 40000,
    density: 5,
    cloudType: 'anvil',
  },
  {
    id: 'medium',
    altitude: 4500,
    altitudeSpread: 2500,
    color: [0.85, 0.87, 0.93],
    sizeRange: [14, 40],
    opacityRange: [0.3, 0.65],
    maxPoints: 40000,
    density: 4,
    cloudType: 'stratus',
  },
  {
    id: 'high',
    altitude: 8500,
    altitudeSpread: 3500,
    color: [0.78, 0.83, 0.96],
    sizeRange: [12, 36],
    opacityRange: [0.15, 0.45],
    maxPoints: 25000,
    density: 3,
    cloudType: 'cirrus',
  },
];

// ── Shaders ───────────────────────────────────────────────────────────

const VERT_BODY = `
  attribute vec2 aMercator;     // mercator x,y [0,1]
  attribute float aElevation;   // elevation above surface (meters)
  attribute float aSize;        // point size (pixels)
  attribute vec4 aColor;        // rgba
  attribute float aRot;         // random rotation
  attribute float aCloudType;   // 0=cumulus, 1=anvil, 2=stratus, 3=cirrus
  attribute float aDensity;     // local density for shaping

  uniform float uDPR;
  uniform float uTime;

  varying vec4 vColor;
  varying float vRot;
  varying float vCloudType;
  varying float vDensity;

  void main() {
    vColor = aColor;
    vRot = aRot + uTime * 0.05;
    vCloudType = aCloudType;
    vDensity = aDensity;

    gl_Position = projectTileWithElevation(aMercator, aElevation);

    float dist = max(gl_Position.w, 1.0);
    float size = aSize * uDPR * (500.0 / dist);
    gl_PointSize = clamp(size, 2.0, 250.0);
  }
`;

const FRAG = `
  precision highp float;

  varying vec4 vColor;
  varying float vRot;
  varying float vCloudType;
  varying float vDensity;

  uniform float uTime;

  // ── Noise functions (inline for WebGL1 compat) ───────────────────

  float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float worleyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float minDist = 1.0;

    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 point = vec2(
          hash(i + neighbor + vec2(73.0, 157.0)),
          hash(i + neighbor + vec2(89.0, 131.0))
        );
        float dist = length(neighbor + point - f);
        minDist = min(minDist, dist);
      }
    }
    return minDist;
  }

  float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amp = 1.0;
    float freq = 1.0;
    float maxVal = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      value += amp * valueNoise(p * freq);
      maxVal += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return value / maxVal;
  }

  // ── Cloud shape functions ────────────────────────────────────────

  // Cumulus: puffy, bumpy, cauliflower-like
  float shapeCumulus(vec2 uv) {
    float r2 = dot(uv, uv);
    if (r2 > 1.0) return 0.0;

    // Multi-lobe bumps
    float bumps = 0.8 + 0.2 * sin(atan(uv.y, uv.x) * 4.0 + r2 * 3.0);
    bumps *= 0.85 + 0.15 * sin(atan(uv.y, uv.x) * 7.0 - r2 * 5.0);

    // Perlin-Worley noise for detail
    float n = fbm(uv * 5.0 + vRot, 4);
    float w = 1.0 - worleyNoise(uv * 3.5 + vRot * 0.5);
    float detail = n * 0.5 + w * 0.5;

    // Soft round shape with bumps
    float shape = 1.0 - smoothstep(0.0, 1.0, r2 * bumps);

    // Erode edges with detail noise
    shape *= 0.7 + 0.3 * detail;

    // Bright bottom (light from below), darker top
    float vertical = (uv.y + 1.0) * 0.5;
    shape *= 0.8 + 0.2 * (1.0 - vertical);

    return max(0.0, shape);
  }

  // Anvil: wide flat top, narrow base — cumulonimbus storm clouds
  float shapeAnvil(vec2 uv) {
    float r2 = dot(uv, uv);
    if (r2 > 1.0) return 0.0;

    // Anvil deformation: stretch horizontally at top, compress at bottom
    float vertical = uv.y; // -1 (bottom) to +1 (top)
    float stretch = 1.0 + max(0.0, vertical) * 1.5; // wide at top
    float compress = 1.0 - max(0.0, -vertical) * 0.4; // narrow at bottom

    vec2 deformed = vec2(uv.x / stretch, uv.y * compress);
    float dr2 = dot(deformed, deformed);
    if (dr2 > 1.0) return 0.0;

    // Anvil shape: flat top via smoothstep
    float topFlat = smoothstep(1.0, 0.3, vertical); // flatten near top

    // Dense turbulent noise for storm clouds
    float n = fbm(uv * 6.0 + vRot, 5);
    float w = 1.0 - worleyNoise(uv * 4.0 + vRot * 0.3);
    float turb = n * 0.4 + w * 0.6;

    // Core shape
    float shape = 1.0 - smoothstep(0.0, 1.0, dr2);
    shape *= topFlat * 0.6 + 0.4;

    // Heavy turbulence erosion for dark storm look
    shape *= 0.55 + 0.45 * turb;

    // Darker base (storm clouds are dark underneath)
    float baseDarken = smoothstep(-0.5, 0.5, vertical);
    shape *= 0.7 + 0.3 * baseDarken;

    return max(0.0, shape);
  }

  // Stratus: flat, layered, smooth
  float shapeStratus(vec2 uv) {
    float r2 = dot(uv, uv);
    if (r2 > 1.0) return 0.0;

    // Flatten vertically
    vec2 stretched = vec2(uv.x, uv.y * 2.5);
    float sr2 = dot(stretched, stretched);

    // Smooth, minimal bumps
    float n = fbm(uv * 3.0 + vRot, 3);
    float w = 1.0 - worleyNoise(uv * 2.0 + vRot * 0.2);
    float detail = n * 0.6 + w * 0.4;

    float shape = 1.0 - smoothstep(0.0, 1.0, sr2 * 0.7);
    shape *= 0.8 + 0.2 * detail;

    return max(0.0, shape);
  }

  // Cirrus: thin wisps, stretched, translucent
  float shapeCirrus(vec2 uv) {
    float r2 = dot(uv, uv);
    if (r2 > 1.0) return 0.0;

    // Stretch horizontally — wispy
    vec2 stretched = vec2(uv.x * 0.3, uv.y * 2.0);
    float sr2 = dot(stretched, stretched);

    // High-frequency noise for wisp detail
    float n = fbm(uv * 8.0 + vec2(vRot, 0.0), 4);
    float w = 1.0 - worleyNoise(uv * 5.0);

    // Thin, broken wisps
    float wisp = n * 0.4 + w * 0.6;
    float shape = 1.0 - smoothstep(0.0, 1.0, sr2);
    shape *= wisp;

    // Very translucent — fade significantly
    shape *= 0.4;

    return max(0.0, shape);
  }

  // ── Main ─────────────────────────────────────────────────────────

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Rotate for variety
    float c = cos(vRot);
    float s = sin(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    // Select cloud shape based on type
    float density = 0.0;
    int type = int(vCloudType + 0.5);

    if (type == 0) {
      density = shapeCumulus(uv);
    } else if (type == 1) {
      density = shapeAnvil(uv);
    } else if (type == 2) {
      density = shapeStratus(uv);
    } else {
      density = shapeCirrus(uv);
    }

    if (density < 0.01) discard;

    float alpha = density * vColor.a;

    // Lighting: brighter top, darker bottom (sun from above)
    float vertical = (gl_PointCoord.y);
    float light = 0.85 + 0.15 * vertical;

    // Core glow (forward scattering)
    float r2 = dot(uv, uv);
    float core = 1.0 + 0.12 * exp(-r2 * 3.0);

    vec3 color = vColor.rgb * light * core;

    // Subtle warm tint in bright areas, cool in shadows
    color += vec3(0.015, 0.015, 0.02) * (1.0 - r2);

    // Storm anvil: darken significantly
    if (type == 1) {
      color *= 0.7;
      alpha *= 1.2;
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

// ── GL helpers ────────────────────────────────────────────────────────

// 11 floats per vertex: mercator(2) + elevation(1) + size(1) + color(4) + rot(1) + cloudType(1) + density(1)
const STRIDE = 44; // 11 * 4 bytes

function compileShader(gl: WebGLRenderingContext, type: number, src: string, prelude?: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, prelude ? `${prelude}\n${src}` : src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader: ${err}`);
  }
  return s;
}

function toMercator(lat: number, lon: number): { x: number; y: number } {
  const x = (lon + 180) / 360;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

// ── Main class ────────────────────────────────────────────────────────

export class CloudPointLayer {
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbos: Map<string, { buf: WebGLBuffer; count: number }> = new Map();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private visible = false;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private shaderPrelude = '';
  private shaderDefine = '';

  // Noise textures
  private cloudNoise: Float32Array | null = null;
  private heightNoise: Float32Array | null = null;
  private stormNoise: Float32Array | null = null;
  private noiseW = 256;
  private noiseH = 128;

  constructor(weather: WeatherManager) {
    this.weather = weather;
    this.weather.on('cloudLayersLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('dataLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('timeChange', () => { this.dirty = true; });

    // Generate base noise textures
    this.generateNoise();
  }

  private generateNoise(): void {
    const seed = Math.round(Date.now() / 300000) % 1000; // changes every ~5 min
    this.cloudNoise = generateCloudNoise(this.noiseW, this.noiseH, seed);
    this.heightNoise = generateHeightNoise(this.noiseW, this.noiseH, seed + 33);
    this.stormNoise = generateStormNoise(this.noiseW, this.noiseH, seed + 77);
  }

  getLayer(): maplibregl.CustomLayerInterface {
    const self = this;
    return {
      id: 'cloud-points-3d',
      type: 'custom',
      renderingMode: '3d',

      onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
        self.map = map;
        self.gl = gl;

        for (const band of BANDS) {
          self.vbos.set(band.id, { buf: gl.createBuffer()!, count: 0 });
        }

        self.timer = setInterval(() => {
          if (self.visible && self.dirty) {
            self.upload(gl);
          }
        }, 5000);

        self.upload(gl);
        console.log('[Clouds] WebGL layer ready');
      },

      render(gl: WebGLRenderingContext, args: any) {
        if (!self.visible) return;

        // Lazy shader compilation
        if (!self.program && args?.shaderData) {
          self.shaderPrelude = args.shaderData.vertexShaderPrelude || '';
          self.shaderDefine = args.shaderData.define || '';
          const prelude = `${self.shaderPrelude}\n${self.shaderDefine}`;
          const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_BODY, prelude);
          const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
          self.program = gl.createProgram()!;
          gl.attachShader(self.program, vs);
          gl.attachShader(self.program, fs);
          gl.linkProgram(self.program);
          if (!gl.getProgramParameter(self.program, gl.LINK_STATUS)) {
            console.error('[Clouds] Link error:', gl.getProgramInfoLog(self.program));
            self.program = null;
            return;
          }
          gl.deleteShader(vs);
          gl.deleteShader(fs);

          self.uniforms.uDPR = gl.getUniformLocation(self.program, 'uDPR');
          self.uniforms.uTime = gl.getUniformLocation(self.program, 'uTime');
          console.log('[Clouds] Shader compiled');
        }
        if (!self.program) return;

        gl.useProgram(self.program);
        gl.uniform1f(self.uniforms.uDPR, window.devicePixelRatio || 1);
        gl.uniform1f(self.uniforms.uTime, (Date.now() - self.startTime) * 0.001);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        const aMercator = gl.getAttribLocation(self.program, 'aMercator');
        const aElevation = gl.getAttribLocation(self.program, 'aElevation');
        const aSize = gl.getAttribLocation(self.program, 'aSize');
        const aCol = gl.getAttribLocation(self.program, 'aColor');
        const aRot = gl.getAttribLocation(self.program, 'aRot');
        const aCloudType = gl.getAttribLocation(self.program, 'aCloudType');
        const aDensity = gl.getAttribLocation(self.program, 'aDensity');

        // Render back to front: high → medium → anvil → low
        const renderOrder = [...BANDS].reverse();
        for (const band of renderOrder) {
          const vb = self.vbos.get(band.id);
          if (!vb || vb.count === 0) continue;

          gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);

          gl.enableVertexAttribArray(aMercator);
          gl.vertexAttribPointer(aMercator, 2, gl.FLOAT, false, STRIDE, 0);
          gl.enableVertexAttribArray(aElevation);
          gl.vertexAttribPointer(aElevation, 1, gl.FLOAT, false, STRIDE, 8);
          gl.enableVertexAttribArray(aSize);
          gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, STRIDE, 12);
          gl.enableVertexAttribArray(aCol);
          gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, STRIDE, 16);
          gl.enableVertexAttribArray(aRot);
          gl.vertexAttribPointer(aRot, 1, gl.FLOAT, false, STRIDE, 32);
          gl.enableVertexAttribArray(aCloudType);
          gl.vertexAttribPointer(aCloudType, 1, gl.FLOAT, false, STRIDE, 36);
          gl.enableVertexAttribArray(aDensity);
          gl.vertexAttribPointer(aDensity, 1, gl.FLOAT, false, STRIDE, 40);

          gl.drawArrays(gl.POINTS, 0, vb.count);
        }

        gl.disableVertexAttribArray(aMercator);
        gl.disableVertexAttribArray(aElevation);
        gl.disableVertexAttribArray(aSize);
        gl.disableVertexAttribArray(aCol);
        gl.disableVertexAttribArray(aRot);
        gl.disableVertexAttribArray(aCloudType);
        gl.disableVertexAttribArray(aDensity);
        gl.depthMask(true);
      },

      onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext) {
        if (self.timer) clearInterval(self.timer);
        for (const [, vb] of self.vbos) gl.deleteBuffer(vb.buf);
        if (self.program) gl.deleteProgram(self.program);
        self.vbos.clear();
      },
    };
  }

  private getCloudTypeValue(type: string): number {
    switch (type) {
      case 'cumulus': return 0;
      case 'anvil': return 1;
      case 'stratus': return 2;
      case 'cirrus': return 3;
      default: return 0;
    }
  }

  private upload(gl: WebGLRenderingContext): void {
    const layers = this.weather.getCloudLayers();
    const coverages: Float32Array[] = [];
    let w = 360, h = 180;

    if (layers) {
      w = layers.width; h = layers.height;
      // Map 3 data layers to 4 visual bands:
      // low → low, low-anvil (if stormy)
      // medium → medium
      // high → high
      coverages.push(layers.low, layers.low, layers.medium, layers.high);
    } else {
      const grid = this.weather.getGrid('surface');
      if (!grid?.fields.cloudFraction) return;
      w = grid.width; h = grid.height;
      const cf = grid.fields.cloudFraction;
      coverages.push(cf, cf, cf, cf);
    }

    const cNoise = this.cloudNoise!;
    const hNoise = this.heightNoise!;
    const sNoise = this.stormNoise!;
    const nw = this.noiseW, nh = this.noiseH;

    for (let bi = 0; bi < BANDS.length; bi++) {
      const band = BANDS[bi];
      const cov = coverages[bi];
      const isFallback = !layers;

      // Per-vertex: mercator(2) + elevation(1) + size(1) + color(4) + rot(1) + cloudType(1) + density(1) = 11 floats
      const pts = new Float32Array(band.maxPoints * 11);
      let n = 0;

      for (let j = 0; j < h && n < band.maxPoints; j++) {
        for (let i = 0; i < w && n < band.maxPoints; i++) {
          let c = cov[j * w + i];
          if (c > 1) c /= 100;
          if (isFallback) c *= [0.5, 0.5, 0.3, 0.2][bi];
          if (c < 0.08) continue;

          // Sample noise at this grid position
          const nu = (i / w);
          const nv = (j / h);
          const ni = Math.floor(nu * (nw - 1));
          const nj = Math.floor(nv * (nh - 1));
          const noiseIdx = nj * nw + ni;

          const shapeNoise = cNoise[noiseIdx];
          const heightVal = hNoise[noiseIdx];
          const stormVal = sNoise[noiseIdx];

          // For anvil band: only spawn where storm intensity is high
          if (band.cloudType === 'anvil' && stormVal < 0.15) continue;

          // Effective coverage combines forecast data with procedural noise
          let effectiveCoverage = c;
          if (band.cloudType === 'anvil') {
            effectiveCoverage *= stormVal;
          } else {
            effectiveCoverage *= (0.5 + 0.5 * shapeNoise);
          }
          if (effectiveCoverage < 0.05) continue;

          // Height modulation: taller clouds where height noise is high
          const heightMod = band.cloudType === 'anvil'
            ? 1.0 + heightVal * 0.8
            : 0.6 + heightVal * 0.4;

          // Number of particles scales with coverage — MORE, SMALLER particles
          const numPts = Math.max(1, Math.ceil(effectiveCoverage * band.density * 1.5));

          const lon = (i / w) * 360 - 180 + 0.5;
          const lat = 90 - (j / h) * 180 - 0.5;

          for (let p = 0; p < numPts && n < band.maxPoints; p++) {
            const jLon = (Math.random() - 0.5) * (360 / w) * 1.2;
            const jLat = (Math.random() - 0.5) * (180 / h) * 1.2;

            // Altitude: band base ± spread, modulated by height noise
            const altBase = band.altitude * heightMod;
            const altSpread = band.altitudeSpread * heightMod;
            const altMeters = Math.max(50, altBase + (Math.random() - 0.5) * altSpread);

            const clampLat = Math.max(-85, Math.min(85, lat + jLat));
            const clampLon = lon + jLon;
            const m = toMercator(clampLat, clampLon);

            // Size: SMALLER base particles, scale with density
            const sizeBase = band.sizeRange[0];
            const sizeVar = sizeBase + effectiveCoverage * (band.sizeRange[1] - sizeBase) * (0.5 + Math.random() * 0.6);

            // Opacity: denser = more opaque
            const alpha = band.opacityRange[0] + effectiveCoverage * (band.opacityRange[1] - band.opacityRange[0]) * (0.6 + Math.random() * 0.4);

            const rot = Math.random() * Math.PI * 2;
            const cloudTypeVal = this.getCloudTypeValue(band.cloudType);
            const density = effectiveCoverage;

            const o = n * 11;
            pts[o]     = m.x;
            pts[o + 1] = m.y;
            pts[o + 2] = altMeters;
            pts[o + 3] = sizeVar;
            pts[o + 4] = band.color[0];
            pts[o + 5] = band.color[1];
            pts[o + 6] = band.color[2];
            pts[o + 7] = alpha;
            pts[o + 8] = rot;
            pts[o + 9] = cloudTypeVal;
            pts[o + 10] = density;
            n++;
          }
        }
      }

      const data = pts.subarray(0, n * 11);
      const vb = this.vbos.get(band.id)!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      vb.count = n;
    }

    this.dirty = false;
    const total = [...this.vbos.values()].reduce((s, b) => s + b.count, 0);
    if (total > 0) {
      console.log(`[Clouds] ${total} pts: ${BANDS.map(b => `${b.id}=${this.vbos.get(b.id)!.count}`).join(' ')}`);
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.dirty = true;
    this.map?.triggerRepaint();
  }
}
