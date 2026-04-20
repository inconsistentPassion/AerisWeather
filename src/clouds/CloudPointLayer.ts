/**
 * CloudPointLayer — 3D cloud visualization as a MapLibre custom WebGL layer.
 *
 * Renders cloud points in true 3D globe space with:
 * - Textured sprites (soft cloud puffs) instead of hard circles
 * - 3 altitude bands with distinct visual character
 * - Depth-based fading and size scaling
 * - Overlapping semi-transparent particles for volumetric density
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const EARTH_RADIUS = 6371000;

// ── Shaders ───────────────────────────────────────────────────────────

const VERT = `
  attribute vec3 aPos;
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aRot;

  uniform mat4 uProj;
  uniform float uDPR;
  uniform float uTime;

  varying vec4 vColor;
  varying float vRot;

  void main() {
    vColor = aColor;
    vRot = aRot + uTime * 0.1;

    vec4 mvPos = uProj * vec4(aPos, 1.0);
    gl_Position = mvPos;

    // Size: scale with distance for depth, larger at altitude
    float dist = max(mvPos.w, 1.0);
    float size = aSize * uDPR * (400.0 / dist);
    gl_PointSize = clamp(size, 2.0, 200.0);
  }
`;

const FRAG = `
  precision mediump float;
  varying vec4 vColor;
  varying float vRot;

  // Procedural soft cloud puff
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Rotate for variation
    float c = cos(vRot);
    float s = sin(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;

    // Multi-lobe cloud shape (not just a circle)
    float noise = 0.85 + 0.15 * (
      sin(atan(uv.y, uv.x) * 3.0 + r2 * 4.0) *
      sin(r2 * 6.0)
    );

    // Soft edge with smooth falloff
    float edge = 1.0 - smoothstep(0.0, 1.0, r2 * noise);
    float alpha = edge * vColor.a;

    // Bright center (light scattering)
    float core = 1.0 + 0.2 * exp(-r2 * 4.0);

    // Subtle warm/cool tint based on distance from center
    vec3 color = vColor.rgb * core;
    color += vec3(0.02, 0.02, 0.03) * (1.0 - r2);

    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Band configs ──────────────────────────────────────────────────────

interface Band {
  id: string;
  altitude: number;
  altitudeSpread: number;
  color: [number, number, number];
  sizeRange: [number, number];
  opacityRange: [number, number];
  maxPoints: number;
  density: number; // points per grid cell multiplier
}

const BANDS: Band[] = [
  {
    id: 'low', altitude: 1200, altitudeSpread: 1800,
    color: [0.96, 0.96, 0.98], sizeRange: [18, 55],
    opacityRange: [0.4, 0.8], maxPoints: 45000, density: 4,
  },
  {
    id: 'medium', altitude: 5000, altitudeSpread: 3000,
    color: [0.88, 0.90, 0.94], sizeRange: [22, 65],
    opacityRange: [0.3, 0.65], maxPoints: 30000, density: 3,
  },
  {
    id: 'high', altitude: 9500, altitudeSpread: 4000,
    color: [0.82, 0.87, 0.97], sizeRange: [25, 75],
    opacityRange: [0.18, 0.45], maxPoints: 20000, density: 2,
  },
];

// ── GL helpers ────────────────────────────────────────────────────────

const STRIDE = 36; // 9 floats: pos(3) + size(1) + color(4) + rot(1)

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
        self.uniforms.uTime = gl.getUniformLocation(self.program, 'uTime');

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
        gl.uniform1f(self.uniforms.uTime, (Date.now() - self.startTime) * 0.001);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        const aPos = gl.getAttribLocation(self.program, 'aPos');
        const aSize = gl.getAttribLocation(self.program, 'aSize');
        const aCol = gl.getAttribLocation(self.program, 'aColor');
        const aRot = gl.getAttribLocation(self.program, 'aRot');

        // Render back to front (high → mid → low) for proper blending
        for (let bi = BANDS.length - 1; bi >= 0; bi--) {
          const band = BANDS[bi];
          const vb = self.vbos.get(band.id);
          if (!vb || vb.count === 0) continue;

          gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);

          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, STRIDE, 0);
          gl.enableVertexAttribArray(aSize);
          gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, STRIDE, 12);
          gl.enableVertexAttribArray(aCol);
          gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, STRIDE, 16);
          gl.enableVertexAttribArray(aRot);
          gl.vertexAttribPointer(aRot, 1, gl.FLOAT, false, STRIDE, 32);

          gl.drawArrays(gl.POINTS, 0, vb.count);
        }

        gl.disableVertexAttribArray(aPos);
        gl.disableVertexAttribArray(aSize);
        gl.disableVertexAttribArray(aCol);
        gl.disableVertexAttribArray(aRot);
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
      // Each point: pos(3) + size(1) + color(4) + rot(1) = 9 floats
      const pts = new Float32Array(band.maxPoints * 9);
      let n = 0;

      for (let j = 0; j < h && n < band.maxPoints; j++) {
        for (let i = 0; i < w && n < band.maxPoints; i++) {
          let c = cov[j * w + i];
          if (c > 1) c /= 100;
          if (isFallback) c *= [0.5, 0.3, 0.2][bi];
          if (c < 0.1) continue;

          const lon = (i / w) * 360 - 180 + 0.5;
          const lat = 90 - (j / h) * 180 - 0.5;
          const numPts = Math.max(1, Math.ceil(c * band.density));

          for (let p = 0; p < numPts && n < band.maxPoints; p++) {
            const jLon = (Math.random() - 0.5) * (360 / w) * 1.1;
            const jLat = (Math.random() - 0.5) * (180 / h) * 1.1;
            const altCenter = band.altitude + (Math.random() - 0.5) * band.altitudeSpread;

            const [x, y, z] = to3D(
              Math.max(-85, Math.min(85, lat + jLat)), lon + jLon, Math.max(100, altCenter)
            );

            // Size: bigger for denser clouds, with variation
            const sizeVar = band.sizeRange[0] + c * (band.sizeRange[1] - band.sizeRange[0]) * (0.6 + Math.random() * 0.8);

            // Opacity: denser clouds more opaque
            const alpha = band.opacityRange[0] + c * (band.opacityRange[1] - band.opacityRange[0]) * (0.7 + Math.random() * 0.3);

            // Random rotation for texture variation
            const rot = Math.random() * Math.PI * 2;

            const o = n * 9;
            pts[o] = x; pts[o+1] = y; pts[o+2] = z;
            pts[o+3] = sizeVar;
            pts[o+4] = band.color[0]; pts[o+5] = band.color[1]; pts[o+6] = band.color[2];
            pts[o+7] = alpha;
            pts[o+8] = rot;
            n++;
          }
        }
      }

      const data = pts.subarray(0, n * 9);
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
