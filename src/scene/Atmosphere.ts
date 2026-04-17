/**
 * Atmosphere — Fresnel-based glow shell around the globe.
 * TODO: Upgrade to Rayleigh/Mie scattering shader for production look.
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';

// Simple fresnel atmosphere vertex shader
const atmosphereVertexShader = `
varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

// Fresnel glow fragment shader
const atmosphereFragmentShader = `
uniform vec3 uCameraPosition;
uniform vec3 uAtmosphereColor;
uniform float uIntensity;

varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
  float fresnel = 1.0 - dot(viewDir, vNormal);
  fresnel = pow(fresnel, 3.0);

  gl_FragColor = vec4(uAtmosphereColor, fresnel * uIntensity);
}
`;

export function createAtmosphere(): THREE.Mesh {
  const atmosphereRadius = GLOBE_RADIUS * 1.015;
  const geometry = new THREE.SphereGeometry(atmosphereRadius, 128, 128);

  const material = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uCameraPosition: { value: new THREE.Vector3() },
      uAtmosphereColor: { value: new THREE.Color(0.3, 0.5, 1.0) },
      uIntensity: { value: 0.8 },
    },
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';

  return mesh;
}
