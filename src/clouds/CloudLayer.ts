/**
 * CloudLayer — MapLibre custom layer rendering Windy-style blue clouds.
 *
 * Pure WebGL2 implementation — no Three.js dependency.
 * Fullscreen quad ray-marched against a cloud shell sphere.
 * Reads MapLibre's native inverse VP matrix for world reconstruction.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';
import cloudVertSrc from '../shaders/cloud.vert';
import cloudFragSrc from '../shaders/cloud.frag';
import { generatePerlinWorley3D } from '../utils/Noise3D';

const EARTH_RADIUS = 6371008.8;
const CLOUD_BASE_ALT = 2000;
const CLOUD_TOP_ALT = 12000;

export function createCloudLayer(weather: WeatherManager): maplibregl.CustomLayerInterface {
  let gl: WebGL2RenderingContext;
  let program: WebGLProgram;
  let vao: WebGLVertexArrayObject;
  let noiseTexture: WebGLTexture;
  let cloudMapTexture: WebGLTexture;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};

  return {
    id: 'volumetric-clouds',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, glCtx: WebGLRenderingContext) {
      gl = glCtx as WebGL2RenderingContext;

      const vertShader = compileShader(gl, gl.VERTEX_SHADER, cloudVertSrc);
      const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, cloudFragSrc);

      if (!vertShader || !fragShader) {
        console.error('Cloud shader compile failed');
        return;
      }

      program = gl.createProgram()!;
      gl.attachShader(program, vertShader);
      gl.attachShader(program, fragShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Cloud shader link error:', gl.getProgramInfoLog(program));
        return;
      }

      // Cache uniform locations
      const names = [
        'uInvVP', 'uCameraPos', 'uPlanetCenter', 'uPlanetRadius',
        'uCloudBaseAlt', 'uCloudTopAlt', 'uTime',
        'uCoverageMult', 'uOpacity',
        'uCloudMap', 'uNoiseTex',
      ];
      for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);

      // Fullscreen quad VAO
      vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1,
      ]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      // 64³ noise texture — bigger = less banding
      noiseTexture = createNoiseTexture(gl, 64);
      cloudMapTexture = createCloudCoverageTexture(gl);

      weather.on('dataLoaded', () => updateCloudMapTexture(gl, cloudMapTexture, weather));
      weather.on('levelChange', () => updateCloudMapTexture(gl, cloudMapTexture, weather));
    },

    render(glCtx: WebGLRenderingContext, args: any) {
      if (!program || !vao) return;
      if (!weather.isLayerActive('clouds')) return;

      gl = glCtx as WebGL2RenderingContext;
      const projData = args?.defaultProjectionData;
      if (!projData) return;

      const vpMatrix: number[] = projData.mainMatrix;
      if (!vpMatrix || vpMatrix.length !== 16) return;

      const invVP = invertMatrix4(vpMatrix);
      if (!invVP) return;

      const camPos = extractCameraPos(invVP);

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);

      gl.uniformMatrix4fv(uniforms.uInvVP, false, new Float32Array(invVP));
      gl.uniform3f(uniforms.uCameraPos, camPos[0], camPos[1], camPos[2]);
      gl.uniform3f(uniforms.uPlanetCenter, 0, 0, 0);
      gl.uniform1f(uniforms.uPlanetRadius, EARTH_RADIUS);
      gl.uniform1f(uniforms.uCloudBaseAlt, CLOUD_BASE_ALT);
      gl.uniform1f(uniforms.uCloudTopAlt, CLOUD_TOP_ALT);
      gl.uniform1f(uniforms.uTime, performance.now() * 0.001);
      gl.uniform1f(uniforms.uCoverageMult, 1.5);
      gl.uniform1f(uniforms.uOpacity, 0.85);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cloudMapTexture);
      gl.uniform1i(uniforms.uCloudMap, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, noiseTexture);
      gl.uniform1i(uniforms.uNoiseTex, 1);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
    },

    onRemove() {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (noiseTexture) gl.deleteTexture(noiseTexture);
      if (cloudMapTexture) gl.deleteTexture(cloudMapTexture);
    },
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createNoiseTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const rawData = generatePerlinWorley3D(size);
  // Convert to RGBA for compatibility
  const data = new Float32Array(size * size * size * 4);
  for (let i = 0; i < rawData.length; i++) {
    const v = rawData[i];
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, size, size, size, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return tex;
}

function createCloudCoverageTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const w = 360, h = 180;
  const data = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = (j * w + i) * 4;
      const lat = (j / h - 0.5) * Math.PI;
      // ITCZ (tropical convergence zone)
      const itcz = Math.exp(-lat * lat * 15) * 0.7;
      // Mid-latitude storm tracks (~30° and ~60°)
      const storm30 = Math.exp(-Math.pow(Math.abs(lat) - 0.52, 2) * 20) * 0.4;
      const storm60 = Math.exp(-Math.pow(Math.abs(lat) - 1.05, 2) * 15) * 0.3;
      // Procedural noise
      const nx = i / w * 6, ny = j / h * 6;
      const noise = (Math.sin(nx * 2.1 + ny * 1.7) * 0.5 + 0.5) *
                    (Math.cos(nx * 1.3 - ny * 2.3) * 0.5 + 0.5);
      data[idx] = Math.min(1.0, itcz + storm30 + storm60 + noise * 0.2);
      data[idx + 1] = 0.7; // humidity
      data[idx + 2] = 0.0;
      data[idx + 3] = 1.0;
    }
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function updateCloudMapTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, weather: WeatherManager) {
  const grid = weather.getGrid('surface');
  if (!grid) return;
  const { width, height, fields } = grid;
  const data = new Float32Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const idx = j * width + i, t = idx * 4;
      data[t] = fields.cloudFraction?.[idx] ?? 0;
      data[t + 1] = fields.humidity?.[idx] ?? 0.5;
      data[t + 2] = 0.0;
      data[t + 3] = 1.0;
    }
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
}

function invertMatrix4(m: number[]): number[] | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * id,
    (a02 * b10 - a01 * b11 - a03 * b09) * id,
    (a31 * b05 - a32 * b04 + a33 * b03) * id,
    (a22 * b04 - a21 * b05 - a23 * b03) * id,
    (a12 * b08 - a10 * b11 - a13 * b07) * id,
    (a00 * b11 - a02 * b08 + a03 * b07) * id,
    (a32 * b02 - a30 * b05 - a33 * b01) * id,
    (a20 * b05 - a22 * b02 + a23 * b01) * id,
    (a10 * b10 - a11 * b08 + a13 * b06) * id,
    (a01 * b08 - a00 * b10 - a03 * b06) * id,
    (a30 * b04 - a31 * b02 + a33 * b00) * id,
    (a21 * b02 - a20 * b04 - a23 * b00) * id,
    (a11 * b07 - a10 * b09 - a12 * b06) * id,
    (a00 * b09 - a01 * b07 + a02 * b06) * id,
    (a31 * b01 - a30 * b03 - a32 * b00) * id,
    (a20 * b03 - a21 * b01 + a22 * b00) * id,
  ];
}

function extractCameraPos(invVP: number[]): [number, number, number] {
  const w = invVP[15];
  if (Math.abs(w) > 1e-6) return [invVP[3] / w, invVP[7] / w, invVP[11] / w];
  return [0, EARTH_RADIUS * 2, 0];
}
