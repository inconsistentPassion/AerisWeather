/**
 * Atmosphere — Rayleigh scattering shell around the globe.
 * Produces the classic blue-at-horizon, orange-at-sunset look.
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';

const atmosphereVertexShader = `
varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vPosition = position;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

/**
 * Rayleigh scattering approximation.
 *
 * Real Rayleigh scattering:
 *   β(λ) ∝ 1/λ^4
 *
 * This shader approximates the effect by:
 *   1. Computing view-dependent scattering intensity
 *   2. Applying altitude-based density falloff
 *   3. Sun-angle dependent color shift (blue → orange → red)
 */
const atmosphereFragmentShader = `
uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uScatteringStrength;
uniform float uRayleighCoeff;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vPosition;

#define PI 3.14159265359

// Rayleigh phase function
float rayleighPhase(float cosTheta) {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Approximate atmospheric density at altitude
float atmosphericDensity(float altitude) {
  // Exponential falloff: ρ = ρ₀ * exp(-h / H)
  // H (scale height) ≈ 8 km for Earth
  float scaleHeight = uPlanetRadius * 0.0012; // ~8km in our units
  return exp(-altitude / scaleHeight);
}

void main() {
  vec3 viewDir = normalize(vWorldPosition - uCameraPosition);
  vec3 normal = normalize(vNormal);

  // View-sun angle
  float cosTheta = dot(viewDir, uSunDirection);
  float phase = rayleighPhase(cosTheta);

  // Fresnel term — more scattering at limb (edge) of atmosphere
  float NdotV = dot(normal, -viewDir);
  float fresnel = pow(1.0 - max(0.0, NdotV), 4.0);

  // Altitude factor
  float r = length(vPosition);
  float altitude = r - uPlanetRadius;
  float density = atmosphericDensity(altitude);

  // Sun elevation affects color
  float sunElevation = dot(normalize(uCameraPosition), uSunDirection);

  // Rayleigh scattering color
  // Short wavelengths scatter more: blue in day, orange at sunset
  vec3 dayColor = vec3(0.25, 0.45, 1.0);    // Deep blue
  vec3 sunsetColor = vec3(1.0, 0.4, 0.15);   // Warm orange
  vec3 nightColor = vec3(0.05, 0.05, 0.15);  // Near black

  // Blend based on sun angle
  float sunFactor = smoothstep(-0.1, 0.3, sunElevation);
  vec3 scatteringColor = mix(sunsetColor, dayColor, sunFactor);

  // At night side, atmosphere is dark
  float nightMask = smoothstep(-0.15, 0.0, sunElevation);

  // Final intensity
  float intensity = fresnel * density * phase * uScatteringStrength;
  intensity *= nightMask;

  // Add limb brightening (sunset glow around the edge)
  float limbGlow = pow(1.0 - abs(NdotV), 8.0) * smoothstep(0.0, -0.2, sunElevation);
  scatteringColor = mix(scatteringColor, vec3(1.0, 0.3, 0.05), limbGlow * 0.5);

  gl_FragColor = vec4(scatteringColor, intensity);
}
`;

export function createAtmosphere(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'atmosphereGroup';

  // Main atmosphere shell (slightly larger than globe)
  const atmosphereRadius = GLOBE_RADIUS * 1.025;
  const geometry = new THREE.SphereGeometry(atmosphereRadius, 128, 128);

  const material = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uCameraPosition: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(0.6, 0.8, -0.4).normalize() },
      uPlanetRadius: { value: GLOBE_RADIUS },
      uAtmosphereRadius: { value: atmosphereRadius },
      uScatteringStrength: { value: 1.5 },
      uRayleighCoeff: { value: 5.5e-6 },
    },
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const atmosphereMesh = new THREE.Mesh(geometry, material);
  atmosphereMesh.name = 'atmosphere';
  group.add(atmosphereMesh);

  // Inner glow (close to surface, for the "looking down" effect)
  const innerRadius = GLOBE_RADIUS * 1.005;
  const innerGeo = new THREE.SphereGeometry(innerRadius, 64, 64);
  const innerMat = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader.replace(
      'uScatteringStrength * density',
      'uScatteringStrength * density * 0.3'
    ),
    uniforms: {
      uCameraPosition: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(0.6, 0.8, -0.4).normalize() },
      uPlanetRadius: { value: GLOBE_RADIUS },
      uAtmosphereRadius: { value: innerRadius },
      uScatteringStrength: { value: 0.5 },
      uRayleighCoeff: { value: 5.5e-6 },
    },
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const innerMesh = new THREE.Mesh(innerGeo, innerMat);
  innerMesh.name = 'atmosphereInner';
  group.add(innerMesh);

  return group;
}
