/**
 * CloudPointLayer — 3D cloud points as a MapLibre custom WebGL layer.
 *
 * Renders cloud points in globe 3D space using MapLibre's native projection
 * matrices. Soft circle particles at 3 altitude bands create volumetric depth.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const EARTH_RADIUS = 6371000;

// ── Shaders ───────────────────────────────────────────────────────────

const VERT = `
  attribute vec3 aPosition;
  attribute float aSize;
  attribute vec4 aColor;
  uniform mat4 uProj;
  uniform float uDPR;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 p = uProj * vec4(aPosition, 1.0);
    gl_Position = p;
    gl_PointSize = aSize * uDPR * (250.0 / max(p.w, 1.0));
    gl_PointSize = clamp(gl_PointSize, 1.0, 150.0);
  }
`;

const FRAG = `
  precision mediump float;
  varying vec4 vColor;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float alpha = 1.0 - smoothstep(0.2, 1.0, r2);
    float glow = 1.0 + 0.12 * (1.0 - r2);
    gl_FragColor = vec4(vColor.rgb * glow, vColor.a * alpha);
  }
`;

// ── Band configs ──────────────────────────────────────────────────────

interface Band {
  id: string;
  altitude: number;
  color: [number, number, number];
  sizeRange: [number, number];
  opacityRange: [number, number];
  maxPoints: number;
}

const BANDS: Band[] = [
  { id: 'low',    altitude: 1500,  color: [0.95, 0.95, 0.97], sizeRange: [10, 40], opacityRange: [0.35, 0.75], maxPoints: 30000 },
  { id: 'medium', altitude: 5500,  color: [0.85, 0.87, 0.93], sizeRange: [12, 48], opacityRange: [0.25, 0.60], maxPoints: 22000 },
  { id: 'high',   altitude: 10000, color: [0.78, 0.84, 0.96], sizeRange: [14, 55], opacityRange: [0.15, 0.45], maxPoints: 15000 },
];

const STRIDE = 32; // 8 floats * 4 bytes

// ── Helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader: ${err}`);
  }
  return s;
}

function to3D(lat: number, lon: number, alt: number): [number, number, number] {
  const lr = lat * Math.PI / 180;
  const ln = lon * Math.PI / 180;
  const r = EARTH_RADIUS + alt;
  return [r * Math.cos(lr) * Math.cos(ln), r * Math.cos(lr) * Math.sin(ln), r * Math.sin(lr)];
}

// ── Class ─────────────────────────────────────────────────────────────

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

  constructor(weather: WeatherManager) {
    this.weather = weather;
    this.weather.on('cloudLayersLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('dataLoaded', () => { this.dirty = true; this.map?.triggerRepaint(); });
    this.weather.on('timeChange', () => { this.dirty = true; });
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

        const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
        self.program = gl.createProgram()!;
        gl.attachShader(self.program, vs);
        gl.attachShader(self.program, fs);
        gl.linkProgram(self.program);
        if (!gl.getProgramParameter(self.program, gl.LINK_STATUS)) {
          console.error('[Clouds] Link error:', gl.getProgramInfoLog(self.program));
          return;
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        self.uniforms.uProj = gl.getUniformLocation(self.program, 'uProj');
        self.uniforms.uDPR = gl.getUniformLocation(self.program, 'uDPR');

        for (const b of BANDS) {
          self.vbos.set(b.id, { buf: gl.createBuffer()!, count: 0 });
        }

        self.timer = setInterval(() => {
          if (self.visible && self.dirty) self.upload(gl);
        }, 3000);

        self.upload(gl);
        console.log('[Clouds] WebGL layer ready');
      },

      render(gl: WebGLRenderingContext, args: any) {
        if (!self.program || !self.visible) return;
        const mat = args?.defaultProjectionData?.mainMatrix;
        if (!mat || mat.length !== 16) return;

        gl.useProgram(self.program);
        gl.uniformMatrix4fv(self.uniforms.uProj, false, new Float32Array(mat));
        gl.uniform1f(self.uniforms.uDPR, window.devicePixelRatio || 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        const aPos = gl.getAttribLocation(self.program, 'aPosition');
        const aSize = gl.getAttribLocation(self.program, 'aSize');
        const aCol = gl.getAttribLocation(self.program, 'aColor');

        for (const b of BANDS) {
          const vb = self.vbos.get(b.id);
          if (!vb || vb.count === 0) continue;

          gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, STRIDE, 0);
          gl.enableVertexAttribArray(aSize);
          gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, STRIDE, 12);
          gl.enableVertexAttribArray(aCol);
          gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, STRIDE, 16);

          gl.drawArrays(gl.POINTS, 0, vb.count);
        }

        gl.disableVertexAttribArray(aPos);
        gl.disableVertexAttribArray(aSize);
        gl.disableVertexAttribArray(aCol);
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

  private upload(gl: WebGLRenderingContext): void {
    const layers = this.weather.getCloudLayers();
    const coverages: Float32Array[] = [];
    let w = 360, h = 180;

    if (layers) {
      w = layers.width; h = layers.height;
      coverages.push(layers.low, layers.medium, layers.high);
    } else {
      const grid = this.weather.getGrid('surface');
      if (!grid?.fields.cloudFraction) return;
      w = grid.width; h = grid.height;
      const cf = grid.fields.cloudFraction;
      coverages.push(cf, cf, cf);
    }

    for (let bi = 0; bi < BANDS.length; bi++) {
      const band = BANDS[bi];
      const cov = coverages[bi];
      const isFallback = !layers;
      const pts = new Float32Array(band.maxPoints * 8);
      let n = 0;

      for (let j = 0; j < h && n < band.maxPoints; j++) {
        for (let i = 0; i < w && n < band.maxPoints; i++) {
          let c = cov[j * w + i];
          if (c > 1) c /= 100; // GFS percentage → fraction
          if (isFallback) c *= [0.5, 0.3, 0.2][bi];
          if (c < 0.12) continue;

          const lon = (i / w) * 360 - 180 + 0.5;
          const lat = 90 - (j / h) * 180 - 0.5;
          const numPts = Math.max(1, Math.ceil(c * 3));

          for (let p = 0; p < numPts && n < band.maxPoints; p++) {
            const jLon = (Math.random() - 0.5) * (360 / w) * 0.9;
            const jLat = (Math.random() - 0.5) * (180 / h) * 0.9;
            const alt = band.altitude * (0.5 + Math.random() * 1.0);
            const [x, y, z] = to3D(
              Math.max(-85, Math.min(85, lat + jLat)), lon + jLon, alt
            );
            const size = band.sizeRange[0] + c * (band.sizeRange[1] - band.sizeRange[0]) * (0.7 + Math.random() * 0.6);
            const alpha = band.opacityRange[0] + c * (band.opacityRange[1] - band.opacityRange[0]);

            const o = n * 8;
            pts[o] = x; pts[o+1] = y; pts[o+2] = z;
            pts[o+3] = size;
            pts[o+4] = band.color[0]; pts[o+5] = band.color[1]; pts[o+6] = band.color[2];
            pts[o+7] = alpha;
            n++;
          }
        }
      }

      // Slice to actual size
      const data = pts.subarray(0, n * 8);
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
