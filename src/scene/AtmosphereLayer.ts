/**
 * AtmosphereLayer — MapLibre custom layer with Rayleigh scattering atmosphere.
 *
 * Works with MapLibre globe projection's coordinate system.
 * MapLibre globe mainMatrix is ALREADY the inverse VP matrix — do NOT invert again.
 */

import maplibregl from 'maplibre-gl';
import atmosphereVert from '../shaders/atmosphere.vert';
import atmosphereFrag from '../shaders/atmosphere.frag';

export function createAtmosphereLayer(): maplibregl.CustomLayerInterface {
  let program: WebGLProgram | null = null;
  let quadBuffer: WebGLBuffer | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let posLoc = -1;

  return {
    id: 'custom-atmosphere',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, atmosphereVert);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, atmosphereFrag);
      if (!vs || !fs) {
        console.error('[Atmosphere] Shader compilation failed');
        return;
      }

      program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[Atmosphere] Program link failed:', gl.getProgramInfoLog(program));
        return;
      }

      const uniformNames = [
        'uInvVP', 'uPlanetRadius', 'uAtmosphereRadius', 'uSunDirection', 'uTime',
      ];
      for (const name of uniformNames) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }

      const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      quadBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

      posLoc = gl.getAttribLocation(program, 'aPosition');
      console.log('[Atmosphere] Initialized');
    },

    render(gl: WebGLRenderingContext, args: any) {
      if (!program) return;

      const projData = args?.defaultProjectionData;
      if (!projData) return;

      // MapLibre globe mainMatrix is ALREADY inverse(P*V) — use directly
      const invVP: number[] = projData.mainMatrix;
      if (!invVP || invVP.length !== 16) return;

      const now = Date.now() / 1000;
      const sunAzimuth = (now * 0.01) % (Math.PI * 2);
      const sunElevation = 0.3 + Math.sin(now * 0.005) * 0.2;
      const sunDir = [
        Math.cos(sunAzimuth) * Math.cos(sunElevation),
        Math.sin(sunElevation),
        Math.sin(sunAzimuth) * Math.cos(sunElevation),
      ];

      // Planet & atmosphere radius — values are relative to the shader's
      // computed camera distance, so they work in any coordinate space.
      const planetRadius = 0.98;
      const atmosphereRadius = 1.02;

      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.uInvVP, false, new Float32Array(invVP));
      gl.uniform1f(uniforms.uPlanetRadius, planetRadius);
      gl.uniform1f(uniforms.uAtmosphereRadius, atmosphereRadius);
      gl.uniform3f(uniforms.uSunDirection, sunDir[0], sunDir[1], sunDir[2]);
      gl.uniform1f(uniforms.uTime, now);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.ALWAYS);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthFunc(gl.LESS);
      gl.disableVertexAttribArray(posLoc);
    },

    onRemove() {},
  };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[Atmosphere] Shader error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
