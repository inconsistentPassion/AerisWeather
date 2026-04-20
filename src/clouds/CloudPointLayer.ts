/**
 * CloudPointLayer — Data-driven volumetric cloud visualization.
 *
 * Uses REAL weather data (Open-Meteo cloudFraction or GFS cloud layers).
 * Distributes data across altitude bands using humidity/temperature.
 * Procedural noise ONLY for particle placement jitter, not data override.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

// ── Band configs — altitude bands with meteorological meaning ─────────

interface BandConfig {
  id: string;
  altitude: number;
  altitudeSpread: number;
  color: [number, number, number];
  sizeRange: [number, number];
  opacityRange: [number, number];
  maxPoints: number;
  density: number;
  cloudType: string;
  /** How much of the cloudFraction data goes to this band (0-1) */
  dataWeight: number;
}

const BANDS: BandConfig[] = [
  {
    id: 'low', altitude: 800, altitudeSpread: 1000,
    color: [0.97, 0.97, 0.99], sizeRange: [8, 24], opacityRange: [0.5, 0.85],
    maxPoints: 100000, density: 8, cloudType: 'cumulus', dataWeight: 0.5,
  },
  {
    id: 'low-mid', altitude: 2000, altitudeSpread: 1500,
    color: [0.93, 0.94, 0.97], sizeRange: [10, 28], opacityRange: [0.4, 0.75],
    maxPoints: 60000, density: 6, cloudType: 'cumulus', dataWeight: 0.3,
  },
  {
    id: 'mid', altitude: 4500, altitudeSpread: 2000,
    color: [0.88, 0.90, 0.95], sizeRange: [12, 32], opacityRange: [0.3, 0.6],
    maxPoints: 40000, density: 4, cloudType: 'stratus', dataWeight: 0.15,
  },
  {
    id: 'high', altitude: 8000, altitudeSpread: 3000,
    color: [0.82, 0.86, 0.96], sizeRange: [14, 36], opacityRange: [0.15, 0.4],
    maxPoints: 20000, density: 3, cloudType: 'cirrus', dataWeight: 0.05,
  },
];

const STRIDE = 44; // 11 floats * 4 bytes

// ── Shaders ───────────────────────────────────────────────────────────

const VERT_BODY = `
  attribute vec2 aMercator;
  attribute float aElevation;
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aRot;
  attribute float aCloudType;
  attribute float aDensity;

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
    gl_PointSize = clamp(size, 2.0, 200.0);
  }
`;

const FRAG = `
  precision highp float;
  varying vec4 vColor;
  varying float vRot;
  varying float vCloudType;
  varying float vDensity;

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
        vec2 point = vec2(hash(i + neighbor + vec2(73.0, 157.0)), hash(i + neighbor + vec2(89.0, 131.0)));
        float dist = length(neighbor + point - f);
        minDist = min(minDist, dist);
      }
    }
    return minDist;
  }

  float fbm(vec2 p, int octaves) {
    float value = 0.0, amp = 1.0, freq = 1.0, maxVal = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      value += amp * valueNoise(p * freq);
      maxVal += amp; amp *= 0.5; freq *= 2.0;
    }
    return value / maxVal;
  }

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float c = cos(vRot), s = sin(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;

    // Procedural shape — only for edge detail, NOT data override
    float n = fbm(uv * 4.0 + vRot, 3);
    float w = 1.0 - worleyNoise(uv * 3.0 + vRot * 0.5);
    float detail = n * 0.5 + w * 0.5;

    // Soft cloud shape with detail erosion at edges
    float shape = 1.0 - smoothstep(0.0, 1.0, r2);
    float edgeDetail = 0.85 + 0.15 * detail;
    float density = shape * edgeDetail;

    if (density < 0.02) discard;

    float alpha = density * vColor.a;

    // Lighting
    float vertical = gl_PointCoord.y;
    float light = 0.85 + 0.15 * vertical;
    float core = 1.0 + 0.1 * exp(-r2 * 3.0);

    vec3 color = vColor.rgb * light * core;
    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, prelude?: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, prelude ? `${prelude}\n${src}` : src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[Clouds] Shader:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    throw new Error('shader');
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
  private visible = true;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private shaderPrelude = '';
  private shaderDefine = '';

  constructor(weather: WeatherManager) {
    this.weather = weather;
    this.weather.on('dataLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('cloudLayersLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('timeChange', () => { this.dirty = true; });

    // Listen for background grid updates
    window.addEventListener('weather-grid-updated', () => {
      this.dirty = true;
      this.map?.triggerRepaint();
    });
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
          if (self.visible && self.dirty) self.upload(gl);
        }, 8000);
        self.upload(gl);
      },

      render(gl: WebGLRenderingContext, args: any) {
        if (!self.visible) return;
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
            console.error('[Clouds] Link:', gl.getProgramInfoLog(self.program));
            self.program = null; return;
          }
          gl.deleteShader(vs); gl.deleteShader(fs);
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

        const aM = gl.getAttribLocation(self.program, 'aMercator');
        const aE = gl.getAttribLocation(self.program, 'aElevation');
        const aS = gl.getAttribLocation(self.program, 'aSize');
        const aC = gl.getAttribLocation(self.program, 'aColor');
        const aR = gl.getAttribLocation(self.program, 'aRot');
        const aT = gl.getAttribLocation(self.program, 'aCloudType');
        const aD = gl.getAttribLocation(self.program, 'aDensity');

        for (const band of [...BANDS].reverse()) {
          const vb = self.vbos.get(band.id);
          if (!vb || vb.count === 0) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);
          gl.enableVertexAttribArray(aM); gl.vertexAttribPointer(aM, 2, gl.FLOAT, false, STRIDE, 0);
          gl.enableVertexAttribArray(aE); gl.vertexAttribPointer(aE, 1, gl.FLOAT, false, STRIDE, 8);
          gl.enableVertexAttribArray(aS); gl.vertexAttribPointer(aS, 1, gl.FLOAT, false, STRIDE, 12);
          gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, STRIDE, 16);
          gl.enableVertexAttribArray(aR); gl.vertexAttribPointer(aR, 1, gl.FLOAT, false, STRIDE, 32);
          gl.enableVertexAttribArray(aT); gl.vertexAttribPointer(aT, 1, gl.FLOAT, false, STRIDE, 36);
          gl.enableVertexAttribArray(aD); gl.vertexAttribPointer(aD, 1, gl.FLOAT, false, STRIDE, 40);
          gl.drawArrays(gl.POINTS, 0, vb.count);
        }

        gl.disableVertexAttribArray(aM); gl.disableVertexAttribArray(aE);
        gl.disableVertexAttribArray(aS); gl.disableVertexAttribArray(aC);
        gl.disableVertexAttribArray(aR); gl.disableVertexAttribArray(aT);
        gl.disableVertexAttribArray(aD);
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
    // Get cloud data — prefer GFS layers, fall back to Open-Meteo surface grid
    const layers = this.weather.getCloudLayers();
    const grid = this.weather.getGrid('surface');

    let coverages: Float32Array[] = [];
    let w = 360, h = 180;
    let dataSource = 'none';

    if (layers) {
      // GFS: separate low/medium/high layers
      w = layers.width; h = layers.height;
      coverages = [layers.low, layers.low, layers.medium, layers.high];
      dataSource = `GFS (${layers.source})`;
    } else if (grid?.fields.cloudFraction) {
      // Open-Meteo: single cloudFraction, distribute across bands by weight
      w = grid.width; h = grid.height;
      const cf = grid.fields.cloudFraction;
      coverages = BANDS.map(b => {
        const weighted = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          weighted[i] = cf[i] * b.dataWeight;
        }
        return weighted;
      });
      dataSource = 'Open-Meteo';
    } else {
      console.warn('[Clouds] No data — skipping upload');
      // Don't generate noise-only clouds
      for (const band of BANDS) {
        this.vbos.get(band.id)!.count = 0;
      }
      this.dirty = false;
      return;
    }

    for (let bi = 0; bi < BANDS.length; bi++) {
      const band = BANDS[bi];
      const cov = coverages[bi];
      const pts = new Float32Array(band.maxPoints * 11);
      let n = 0;

      for (let j = 0; j < h && n < band.maxPoints; j++) {
        for (let i = 0; i < w && n < band.maxPoints; i++) {
          let c = cov[j * w + i];
          if (c > 1) c /= 100;
          if (c < 0.05) continue;

          // Use REAL data directly — no noise multiplication
          const numPts = Math.max(1, Math.ceil(c * band.density));

          const lon = (i / w) * 360 - 180 + 0.5;
          const lat = 90 - (j / h) * 180 - 0.5;

          for (let p = 0; p < numPts && n < band.maxPoints; p++) {
            const jLon = (Math.random() - 0.5) * (360 / w) * 1.1;
            const jLat = (Math.random() - 0.5) * (180 / h) * 1.1;
            const altMeters = Math.max(50, band.altitude + (Math.random() - 0.5) * band.altitudeSpread);

            const clampLat = Math.max(-85, Math.min(85, lat + jLat));
            const m = toMercator(clampLat, lon + jLon);

            const sizeVar = band.sizeRange[0] + c * (band.sizeRange[1] - band.sizeRange[0]) * (0.5 + Math.random() * 0.5);
            const alpha = band.opacityRange[0] + c * (band.opacityRange[1] - band.opacityRange[0]);
            const rot = Math.random() * Math.PI * 2;

            const o = n * 11;
            pts[o] = m.x; pts[o+1] = m.y; pts[o+2] = altMeters;
            pts[o+3] = sizeVar;
            pts[o+4] = band.color[0]; pts[o+5] = band.color[1]; pts[o+6] = band.color[2]; pts[o+7] = alpha;
            pts[o+8] = rot;
            pts[o+9] = this.getCloudTypeValue(band.cloudType);
            pts[o+10] = c;
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
    console.log(`[Clouds] ${total} pts from ${dataSource}: ${BANDS.map(b => `${b.id}=${this.vbos.get(b.id)!.count}`).join(' ')}`);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.dirty = true;
    this.map?.triggerRepaint();
  }
}
