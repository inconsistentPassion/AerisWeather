// atmosphere.frag — Rayleigh atmosphere scattering (GLSL 100 / WebGL 1)
//
// Coordinate-agnostic: computes camera position from uInvVP in-shader.
// Planet radius is relative (camera is typically ~2× planet radius away).

precision highp float;

uniform mat4 uInvVP;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uSunDirection;
uniform float uTime;

varying vec2 vUV;

#define PI 3.14159265359
#define SAMPLES 12
#define LIGHT_SAMPLES 3

// --- Phase functions ---

float rayleighPhase(float cosTheta) {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// --- Ray-sphere intersection ---

vec2 hitSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// --- Density model ---

float densityAtRadius(float r) {
  // Exponential falloff from planet surface
  float altitude = r - uPlanetRadius;
  float scaleHeight = uPlanetRadius * 0.15; // ~15% of planet radius
  return exp(-max(0.0, altitude) / scaleHeight);
}

float opticalDepth(vec3 origin, vec3 direction, float maxDist) {
  float stepSize = maxDist / float(LIGHT_SAMPLES);
  float depth = 0.0;
  for (int i = 0; i < LIGHT_SAMPLES; i++) {
    float t = stepSize * (float(i) + 0.5);
    vec3 pos = origin + direction * t;
    float r = length(pos);
    if (r < uPlanetRadius) return 1e6; // inside planet = full occlusion
    depth += densityAtRadius(r) * stepSize;
  }
  return depth;
}

void main() {
  // Unproject NDC to world space using the inverse VP matrix
  // (MapLibre globe mainMatrix is already inv(P*V))
  vec2 ndc = vUV * 2.0 - 1.0;
  vec4 nearH = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 farH  = uInvVP * vec4(ndc,  1.0, 1.0);
  vec3 nearW = nearH.xyz / nearH.w;
  vec3 farW  = farH.xyz / farH.w;

  // Camera position: unproject the NDC origin (center of near plane)
  vec4 camH = uInvVP * vec4(0.0, 0.0, -1.0, 1.0);
  vec3 ro = camH.xyz / camH.w;

  // Scale planet radius relative to actual camera distance
  float camDist = length(ro);
  float planetR = uPlanetRadius * camDist;
  float atmoR   = uAtmosphereRadius * camDist;

  // Ray direction in camera-relative space
  vec3 rd = normalize(farW - nearW);

  // Intersect atmosphere sphere (centered at origin = camera target)
  vec2 atmoHit = hitSphere(ro, rd, atmoR);
  if (atmoHit.y < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Check if ray hits planet surface
  vec2 planetHit = hitSphere(ro, rd, planetR);
  float tEnd = atmoHit.y;
  if (planetHit.x > 0.0) {
    tEnd = min(tEnd, planetHit.x);
  }

  float tStart = max(0.0, atmoHit.x);
  if (tStart >= tEnd) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Raymarch through atmosphere
  float stepSize = (tEnd - tStart) / float(SAMPLES);
  vec3 sumRayleigh = vec3(0.0);
  float sumMie = 0.0;
  float opticalDepthCamera = 0.0;

  // Scattering coefficients (scaled for visual impact)
  vec3 betaR = vec3(5.5e-3, 13.0e-3, 22.4e-3);
  float betaM = 21.0e-3;
  vec3 sunDir = normalize(uSunDirection);

  for (int i = 0; i < SAMPLES; i++) {
    float t = tStart + stepSize * (float(i) + 0.5);
    vec3 samplePos = ro + rd * t;
    float r = length(samplePos);

    float density = densityAtRadius(r);
    opticalDepthCamera += density * stepSize;

    // Sun light optical depth (shadow check)
    vec2 lightPlanetHit = hitSphere(samplePos, sunDir, planetR);
    float inShadow = lightPlanetHit.x > 0.0 ? 0.0 : 1.0;
    float maxLightDist = max(0.0, atmoR - r);
    float lightDepth = opticalDepth(samplePos, sunDir, maxLightDist) * inShadow;

    // Attenuation (extinction)
    float totalDepth = opticalDepthCamera + lightDepth;
    vec3 attn = exp(-(betaR * totalDepth + vec3(betaM) * totalDepth));

    sumRayleigh += density * attn * stepSize;
    sumMie += density * attn.r * stepSize;
  }

  // Phase functions
  float cosTheta = dot(rd, sunDir);

  // Rayleigh scattering (blue sky)
  vec3 scatter = sumRayleigh * betaR * rayleighPhase(cosTheta);

  // Mie scattering (sun glow, forward-scattering)
  scatter += vec3(sumMie * betaM * miePhase(cosTheta, 0.85) * 0.03);

  // Sun glow (direct)
  float sunGlow = pow(max(0.0, cosTheta), 256.0) * 1.5;
  sunGlow += pow(max(0.0, cosTheta), 32.0) * 0.15;
  scatter += vec3(1.0, 0.92, 0.75) * sunGlow * exp(-opticalDepthCamera * 0.3);

  // Horizon glow (limb brightening)
  vec3 viewDir = normalize(ro);
  float horizonAngle = dot(viewDir, rd);
  float horizonGlow = pow(max(0.0, 1.0 - abs(horizonAngle)), 6.0) * 0.4;
  scatter += vec3(0.15, 0.35, 0.9) * horizonGlow;

  // Alpha: blend based on scattering intensity + horizon glow
  float intensity = length(scatter);
  float alpha = smoothstep(0.001, 0.05, intensity) * 0.75;
  alpha += horizonGlow * 0.25;
  alpha = clamp(alpha, 0.0, 0.85);

  // Tone mapping to prevent oversaturation
  scatter = scatter / (scatter + vec3(1.0));

  gl_FragColor = vec4(scatter, alpha);
}
