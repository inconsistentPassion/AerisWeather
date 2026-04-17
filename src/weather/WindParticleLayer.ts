/**
 * WindParticleLayer — WebGL wind particles rendered ON the globe surface.
 *
 * MapLibre CustomLayerInterface using GL_POINTS on the Mercator grid.
 * Particles advect along u/v wind field each frame, colored by speed,
 * faded by age. Replaces the static GeoJSON arrow layer entirely.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const NUM_PARTICLES = 8000;
const MAX_AGE = 180;     // frames (~3 s @ 60fps)
const SPAWN_BATCH = 80;  // respawn budget per frame
const PX_PER_MS = 0.3;   // screen-pixel offset per m/s per frame

/* Mercator helpers (MapLibre convention: [0,1] × [0,1]) */
function mercX(lng: number): number { return lng / 360 + 0.5; }
function mercY(lat: number): number {
  const s = Math.sin(lat * Math.PI / 180);
  return 0.5 - 0.25 * Math.log((1 + s) / (1 - s)) / Math.PI;
}

/* ── GL helpers ──────────────────────────────────────────────── */

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error('Shader error:', gl.getShaderInfoLog(s));
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error('Program error:', gl.getProgramInfoLog(p));
  return p;
}

/* ── colour ramp ─────────────────────────────────────────────── */

function speedColor(t: number): [number, number, number] {
  if (t < 0.33) {
    const s = t / 0.33;
    return [30 + s * 50, 100 + s * 155, 220 - s * 20];
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return [80 + s * 175, 255 - s * 55, 200 - s * 180];
  }
  const s = (t - 0.66) / 0.34;
  return [255, 200 - s * 180, 20 - s * 20];
}

/* ── factory ─────────────────────────────────────────────────── */

export function createWindParticleLayer(weather: WeatherManager): maplibregl.CustomLayerInterface {
  let gl: WebGL2RenderingContext;
  let program: WebGLProgram;
  let vao: WebGLVertexArrayObject;
  let posBuf: WebGLBuffer;
  let colBuf: WebGLBuffer;
  let uMatrix: WebGLUniformLocation | null = null;

  // particle state — [lon, lat, age, speed]
  let particles: Float64Array;
  // GPU buffers (mercator x/y + rgba per vertex)
  let posData: Float32Array;
  let colData: Float32Array;

  /* ── advect one frame ──────────────────────────────────────── */
  function advect(windU: Float32Array, windV: Float32Array, w: number, h: number, map: maplibregl.Map) {
    let spawned = 0;

    for (let i = 0; i < NUM_PARTICLES; i++) {
      const bi = i * 4;
      let lon = particles[bi], lat = particles[bi + 1], age = particles[bi + 2];

      age += 1;
      if (age >= MAX_AGE || spawned < SPAWN_BATCH) {
        // respawn
        if (age >= MAX_AGE || Math.random() < 0.01) {
          particles[bi]     = (Math.random() - 0.5) * 360;
          particles[bi + 1] = (Math.random() - 0.5) * 180;
          particles[bi + 2] = Math.random() * 20;
          particles[bi + 3] = 0;
          spawned++;
          continue;
        }
      }

      // grid sample
      const gi = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
      const gj = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
      const idx = gj * w + gi;
      const u = windU[idx] || 0, v = windV[idx] || 0;
      const spd = Math.sqrt(u * u + v * v);
      particles[bi + 3] = spd;

      if (spd < 0.3) { particles[bi + 2] = age; continue; }

      // screen-space advect (zoom-independent speed)
      const pt = map.project([lon, lat] as any);
      const npt = map.unproject([pt.x + u * PX_PER_MS, pt.y - v * PX_PER_MS] as any);
      lon = npt.lng;
      lat = npt.lat;

      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      lat = Math.max(-85, Math.min(85, lat));

      particles[bi] = lon;
      particles[bi + 1] = lat;
      particles[bi + 2] = age;

      // fill GPU arrays
      posData[i * 2]     = mercX(lon);
      posData[i * 2 + 1] = mercY(lat);

      const alpha = age < 12 ? age / 12
        : age > MAX_AGE - 25 ? (MAX_AGE - age) / 25
        : 1;
      const [r, g, b] = speedColor(Math.min(spd / 25, 1));
      const a = alpha * 0.85;
      colData[i * 4]     = r / 255;
      colData[i * 4 + 1] = g / 255;
      colData[i * 4 + 2] = b / 255;
      colData[i * 4 + 3] = a;
    }
  }

  /* ── init particles ────────────────────────────────────────── */
  function initParticles() {
    particles = new Float64Array(NUM_PARTICLES * 4);
    posData   = new Float32Array(NUM_PARTICLES * 2);
    colData   = new Float32Array(NUM_PARTICLES * 4);
    for (let i = 0; i < NUM_PARTICLES; i++) {
      const bi = i * 4;
      particles[bi]     = (Math.random() - 0.5) * 360;
      particles[bi + 1] = (Math.random() - 0.5) * 180;
      particles[bi + 2] = Math.random() * MAX_AGE;
      particles[bi + 3] = 0;
      posData[i * 2]     = mercX(particles[bi]);
      posData[i * 2 + 1] = mercY(particles[bi + 1]);
      colData[i * 4 + 3] = 0.4;
    }
  }

  return {
    id: 'wind-particles',
    type: 'custom',
    renderingMode: '2d' as any,

    onAdd(map: maplibregl.Map, glCtx: WebGLRenderingContext) {
      gl = glCtx as WebGL2RenderingContext;
      initParticles();

      const vs = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
        uniform mat4 u_matrix;
        in vec2 a_pos;
        in vec4 a_color;
        out vec4 v_color;
        void main() {
          gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
          gl_PointSize = 3.0;
          v_color = a_color;
        }`);

      const fs = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
        precision mediump float;
        in vec4 v_color;
        out vec4 fragColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.15, d) * v_color.a;
          fragColor = vec4(v_color.rgb * a, a);
        }`);

      program = linkProgram(gl, vs, fs);
      uMatrix = gl.getUniformLocation(program, 'u_matrix');

      vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);

      posBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, posData.byteLength, gl.DYNAMIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      colBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferData(gl.ARRAY_BUFFER, colData.byteLength, gl.DYNAMIC_DRAW);
      const aCol = gl.getAttribLocation(program, 'a_color');
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 0, 0);

      gl.bindVertexArray(null);
    },

    render(glCtx: WebGLRenderingContext, args: any) {
      if (!weather.isLayerActive('wind')) return;
      gl = glCtx as WebGL2RenderingContext;

      const wf = weather.getWindField('surface');
      if (!wf) return;

      advect(wf.u, wf.v, 360, 180, args.map as maplibregl.Map);

      // upload
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, posData);
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, colData);

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(uMatrix, false, new Float32Array(args.matrix));

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.drawArrays(gl.POINTS, 0, NUM_PARTICLES);

      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },

    onRemove() {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (posBuf) gl.deleteBuffer(posBuf);
      if (colBuf) gl.deleteBuffer(colBuf);
    },
  };
}
