// atmosphere.frag — Physically-based atmosphere scattering for MapLibre globe
// Inspired by: Mapbox GL JS atmosphere, Scratchapixel Rayleigh scattering
// Renders an atmosphere shell with proper Rayleigh + Mie approximation

#version 300 es
precision highp float;

uniform mat4 uInvVP;
uniform vec3 uCameraPos;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uSunDirection;
uniform float uTime;

in vec2 vUV;
out vec4 fragColor;

#define PI 3.14159265359
#define SAMPLES 16
#define LIGHT_SAMPLES 4

// Rayleigh phase function
float rayleighPhase(float cosTheta) {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// Mie phase function (Henyey-Greenstein)
float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Combined phase
float phase(float cosTheta) {
  float rayleigh = rayleighPhase(cosTheta);
  float mie = miePhase(cosTheta, 0.85);
  return mix(rayleigh, mie, 0.1);
}

// Ray-sphere intersection
vec2 hitSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Atmospheric density at altitude (exponential falloff)
float densityAtAltitude(float altitude) {
  float scaleHeight = uPlanetRadius * 0.0012; // ~8km scale height
  return exp(-altitude / scaleHeight);
}

// Optical depth along a ray segment
float opticalDepth(vec3 origin, vec3 direction, float maxDist) {
  float stepSize = maxDist / float(LIGHT_SAMPLES);
  float depth = 0.0;

  for (int i = 0; i < LIGHT_SAMPLES; i++) {
    float t = stepSize * (float(i) + 0.5);
    vec3 samplePos = origin + direction * t;
    float r = length(samplePos) - uPlanetRadius;
    depth += densityAtAltitude(r) * stepSize;
  }

  return depth;
}

void main() {
  // Reconstruct world ray
  vec2 ndc = vUV * 2.0 - 1.0;
  vec4 nearW = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 farW  = uInvVP * vec4(ndc,  1.0, 1.0);
  nearW /= nearW.w;
  farW  /= farW.w;

  vec3 ro = uCameraPos - uPlanetCenter;
  vec3 rd = normalize(farW.xyz - nearW.xyz);

  // Intersect atmosphere shell
  vec2 atmoHit = hitSphere(ro, rd, uAtmosphereRadius);
  if (atmoHit.y < 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  // Check planet occlusion
  vec2 planetHit = hitSphere(ro, rd, uPlanetRadius);
  float tEnd = atmoHit.y;
  if (planetHit.x > 0.0) {
    tEnd = min(tEnd, planetHit.x);
  }

  float tStart = max(0.0, atmoHit.x);
  if (tStart >= tEnd) {
    fragColor = vec4(0.0);
    return;
  }

  // March through atmosphere
  float stepSize = (tEnd - tStart) / float(SAMPLES);
  vec3 sumRayleigh = vec3(0.0);
  float sumMie = 0.0;
  float opticalDepthCamera = 0.0;

  // Wavelength-dependent scattering coefficients (Rayleigh)
  vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6); // RGB wavelengths
  vec3 betaM = vec3(21e-6); // Mie coefficient (gray)

  for (int i = 0; i < SAMPLES; i++) {
    float t = tStart + stepSize * (float(i) + 0.5);
    vec3 samplePos = ro + rd * t;
    float r = length(samplePos);

    float altitude = r - uPlanetRadius;
    float density = densityAtAltitude(altitude);

    opticalDepthCamera += density * stepSize;

    // Light direction from sample point to sun
    vec3 sunDir = normalize(uSunDirection);

    // Check if sample is in shadow (behind planet)
    vec2 lightPlanetHit = hitSphere(samplePos, sunDir, uPlanetRadius);
    float inShadow = lightPlanetHit.x > 0.0 ? 0.0 : 1.0;

    // Optical depth from sample to sun
    float lightDepth = opticalDepth(samplePos, sunDir, uAtmosphereRadius - r) * inShadow;

    // Attenuation
    vec3 attn = exp(-(betaR * (opticalDepthCamera + lightDepth) + betaM * (opticalDepthCamera + lightDepth) * 1.1));

    sumRayleigh += density * attn * stepSize;
    sumMie += density * attn * stepSize;
  }

  float cosTheta = dot(rd, normalize(uSunDirection));
  vec3 scatter = sumRayleigh * betaR * rayleighPhase(cosTheta) +
                 sumMie * betaM * miePhase(cosTheta, 0.85) * 0.05;

  // Sun glow (bright disc at sun direction)
  float sunGlow = pow(max(0.0, cosTheta), 256.0) * 2.0;
  sunGlow += pow(max(0.0, cosTheta), 32.0) * 0.1;

  // Intensity with tone mapping
  float intensity = length(scatter);
  scatter += vec3(1.0, 0.95, 0.8) * sunGlow * exp(-opticalDepthCamera * 0.5);

  // Horizon glow (bright band at atmosphere limb)
  float horizonAngle = dot(normalize(ro), rd);
  float horizonGlow = pow(1.0 - abs(horizonAngle), 8.0) * 0.3;

  scatter += vec3(0.3, 0.5, 1.0) * horizonGlow;

  // Alpha from scattering intensity
  float alpha = smoothstep(0.0, 0.001, intensity) * 0.8;
  alpha += horizonGlow * 0.2;
  alpha = clamp(alpha, 0.0, 0.85);

  fragColor = vec4(scatter, alpha);
}
