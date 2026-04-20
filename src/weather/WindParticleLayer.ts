/**
 * WindParticleLayer — WebGL-accelerated wind streaks on the MapLibre globe.
 *
 * Eliminates per-frame map.project() calls by projecting particles in the
 * vertex shader using MapLibre's globe matrix. All 50k particles + trails
 * render in a single draw call per color bin.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_PARTICLES = 50000;
const TRAIL_LEN = 5;
const MAX_AGE = 100;
const BASE_SPEED = 0.004;
const NUM_BINS = 8;

const BIN_COLORS: [number, number, number, number][] = [
  [30, 100, 220, 0.50],
  [55, 180, 210, 0.55],
  [80, 240, 195, 0.55],
  [140, 255, 120, 0.55],
  [210, 230, 55, 0.55],
  [255, 180, 30, 0.60],
  [255, 100, 15, 0.65],
  [255, 30, 10, 0.70],
];

// ── Shaders ───────────────────────────────────────────────────────────

// Vertex shader — uses MapLibre's projectTileFor3D for correct globe projection
const VERT_BODY = `
  attribute vec3 aMercator;  // x: mercatorX [0,1], y: mercatorY [0,1], z: elevation meters
  attribute float aAlpha;

  uniform float uLineWidth;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectTileFor3D(aMercator);
    gl_PointSize = max(uLineWidth, 1.0);
  }
`;

const FRAG = `
  precision mediump float;
  varying float vAlpha;
  uniform vec4 uColor;
  void main() {
    gl_FragColor = vec4(uColor.rgb, uColor.a * vAlpha);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, prelude?: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, prelude ? `${prelude}\n${src}` : src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[Wind] Shader error:', gl.getShaderInfoLog(s));
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

interface BinGL {
  lineVBO: WebGLBuffer;
  lineCount: number;
}

export class WindParticleLayer {
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private bins: Map<number, BinGL> = new Map();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private visible = false;
  private shaderPrelude = '';
  private shaderDefine = '';

  // Particle state
  private lon = new Float64Array(TOTAL_PARTICLES);
  private lat = new Float64Array(TOTAL_PARTICLES);
  private age = new Float64Array(TOTAL_PARTICLES);
  private trailLon = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailLat = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailHead = new Uint16Array(TOTAL_PARTICLES);

  // Pre-allocated line segment buffers per bin
  private binSegs: Float32Array[] = [];
  private binSegCount = new Int32Array(NUM_BINS);

  constructor(weather: WeatherManager) {
    this.weather = weather;

    // Pre-allocate segment buffers (pos0(3) + alpha0(1) + pos1(3) + alpha1(1) = 8 floats per segment)
    const maxSegs = 20000;
    for (let b = 0; b < NUM_BINS; b++) {
      this.binSegs.push(new Float32Array(maxSegs * 8));
    }

    for (let i = 0; i < TOTAL_PARTICLES; i++) this.spawn(i);
  }

  getLayer(): maplibregl.CustomLayerInterface {
    const self = this;
    return {
      id: 'wind-lines',
      type: 'custom',
      renderingMode: '2d',

      onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
        self.map = map;
        self.gl = gl;

        for (let b = 0; b < NUM_BINS; b++) {
          self.bins.set(b, { lineVBO: gl.createBuffer()!, lineCount: 0 });
        }

        console.log('[Wind] WebGL layer added');
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
            console.error('[Wind] Link error:', gl.getProgramInfoLog(self.program));
            self.program = null;
            return;
          }
          gl.deleteShader(vs);
          gl.deleteShader(fs);

          self.uniforms.uLineWidth = gl.getUniformLocation(self.program, 'uLineWidth');
          self.uniforms.uColor = gl.getUniformLocation(self.program, 'uColor');
          console.log('[Wind] Shader compiled');
        }
        if (!self.program) return;

        // Advect + build geometry
        self.tick();

        // Upload + draw
        gl.useProgram(self.program);
        gl.uniform1f(self.uniforms.uLineWidth, 2.0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        const aMercator = gl.getAttribLocation(self.program, 'aMercator');
        const aAlpha = gl.getAttribLocation(self.program, 'aAlpha');

        for (let b = 0; b < NUM_BINS; b++) {
          const binGL = self.bins.get(b)!;
          if (binGL.lineCount === 0) continue;

          const [r, g, bl, alphaBase] = BIN_COLORS[b];
          gl.uniform4f(self.uniforms.uColor, r / 255, g / 255, bl / 255, 1.0);

          gl.bindBuffer(gl.ARRAY_BUFFER, binGL.lineVBO);

          const stride = 16; // 4 floats: x, y, z, alpha
          gl.enableVertexAttribArray(aMercator);
          gl.vertexAttribPointer(aMercator, 3, gl.FLOAT, false, stride, 0);
          gl.enableVertexAttribArray(aAlpha);
          gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, stride, 12);

          gl.drawArrays(gl.LINES, 0, binGL.lineCount);
        }

        gl.disableVertexAttribArray(aMercator);
        gl.disableVertexAttribArray(aAlpha);
        gl.depthMask(true);
      },

      onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext) {
        for (const [, bg] of self.bins) gl.deleteBuffer(bg.lineVBO);
        if (self.program) gl.deleteProgram(self.program);
        self.bins.clear();
      },
    };
  }

  private spawn(i: number): void {
    this.lon[i] = (Math.random() - 0.5) * 360;
    this.lat[i] = (Math.random() - 0.5) * 180;
    this.age[i] = Math.random() * MAX_AGE * 0.3;
    this.trailHead[i] = 0;
    const b = i * TRAIL_LEN;
    for (let t = 0; t < TRAIL_LEN; t++) {
      this.trailLon[b + t] = this.lon[i];
      this.trailLat[b + t] = this.lat[i];
    }
  }

  private sampleWind(u: Float32Array, v: Float32Array, lon: number, lat: number) {
    const gw = 360, gh = 180;
    const nLon = ((lon + 180) % 360 + 360) % 360;
    const x = (nLon / 360) * gw, y = ((90 - lat) / 180) * gh;
    const x0 = Math.floor(x) % gw, y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
    const x1 = (x0 + 1) % gw, y1 = Math.min(gh - 1, y0 + 1);
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const bl = (a: number, b: number, c: number, d: number) =>
      a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    const uVal = bl(u[y0*gw+x0], u[y0*gw+x1], u[y1*gw+x0], u[y1*gw+x1]);
    const vVal = bl(v[y0*gw+x0], v[y0*gw+x1], v[y1*gw+x0], v[y1*gw+x1]);
    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
  }

  /**
   * One simulation + geometry build tick. Called each render frame.
   * NO map.project() calls — all projection done in vertex shader.
   */
  private tick(): void {
    const wf = this.weather.getWindField('surface');
    if (!wf) {
      // Clear all bins
      for (let b = 0; b < NUM_BINS; b++) this.binSegCount[b] = 0;
      this.flush();
      return;
    }

    const { u, v } = wf;
    this.binSegCount.fill(0);

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      this.age[i] += 1;
      if (this.age[i] >= MAX_AGE) { this.spawn(i); continue; }

      const wind = this.sampleWind(u, v, this.lon[i], this.lat[i]);

      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.lat[i] * Math.PI / 180));
        const sf = Math.sqrt(wind.speed);
        this.lon[i] += (wind.u / wind.speed) * sf * BASE_SPEED / cosLat;
        this.lat[i] += (wind.v / wind.speed) * sf * BASE_SPEED;
        if (this.lon[i] > 180) this.lon[i] -= 360;
        if (this.lon[i] < -180) this.lon[i] += 360;
        this.lat[i] = Math.max(-85, Math.min(85, this.lat[i]));
      }

      const h = this.trailHead[i];
      const tb = i * TRAIL_LEN;
      this.trailLon[tb + h] = this.lon[i];
      this.trailLat[tb + h] = this.lat[i];
      this.trailHead[i] = (h + 1) % TRAIL_LEN;

      if (wind.speed < 0.3 || this.age[i] < TRAIL_LEN) continue;

      const bin = Math.min(NUM_BINS - 1, Math.floor((wind.speed / 25) * NUM_BINS));
      const alpha = 0.3 + (bin / NUM_BINS) * 0.5;
      const segs = this.binSegs[bin];
      let sc = this.binSegCount[bin];
      const maxSegs = segs.length / 8;

      // Build trail segments as mercator globe positions
      for (let t = 0; t < TRAIL_LEN - 1 && sc < maxSegs; t++) {
        const s0 = (h + t) % TRAIL_LEN;
        const s1 = (h + t + 1) % TRAIL_LEN;
        const lon0 = this.trailLon[tb + s0], lat0 = this.trailLat[tb + s0];
        const lon1 = this.trailLon[tb + s1], lat1 = this.trailLat[tb + s1];

        // Skip date-line wrapping
        if (Math.abs(lon1 - lon0) > 10) continue;

        const m0 = toMercator(lat0, lon0);
        const m1 = toMercator(lat1, lon1);
        // Elevation: small offset above surface for wind visual
        const elev = 500 + (bin / NUM_BINS) * 3000;

        // Trail alpha fades toward tail
        const trailAlpha = alpha * (t / TRAIL_LEN);

        const off = sc * 8;
        segs[off] = m0.x; segs[off+1] = m0.y; segs[off+2] = elev; segs[off+3] = trailAlpha;
        segs[off+4] = m1.x; segs[off+5] = m1.y; segs[off+6] = elev; segs[off+7] = trailAlpha * 0.9;
        sc++;
      }

      this.binSegCount[bin] = sc;
    }

    this.flush();
  }

  private flush(): void {
    const gl = this.gl;
    if (!gl) return;

    for (let b = 0; b < NUM_BINS; b++) {
      const binGL = this.bins.get(b)!;
      const count = this.binSegCount[b];
      const segs = this.binSegs[b];

      if (count > 0) {
        // Upload segment data (each segment = 2 endpoints × 4 floats)
        // For GL_LINES, we need flat array of all endpoints
        const lineData = segs.subarray(0, count * 8);
        gl.bindBuffer(gl.ARRAY_BUFFER, binGL.lineVBO);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
        binGL.lineCount = count * 2; // 2 vertices per segment
      } else {
        binGL.lineCount = 0;
      }
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.map?.triggerRepaint();
  }

  destroy(): void {
    this.visible = false;
  }
}
