// atmosphere.frag — Rayleigh + Mie atmosphere scattering (GLSL 100 / WebGL 1)

precision highp float;

uniform mat4 uInvVP;
uniform vec3 uCameraPos;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uSunDirection;
uniform float uTime;

varying vec2 vUV;

#define PI 3.14159265359
#define SAMPLES 16
#define LIGHT_SAMPLES 4

float rayleighPhase(float cosTheta) {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

float phaseFunc(float cosTheta) {
  float rayleigh = rayleighPhase(cosTheta);
  float mie = miePhase(cosTheta, 0.85);
  return mix(rayleigh, mie, 0.1);
}

vec2 hitSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

float densityAtAltitude(float altitude) {
  float scaleHeight = uPlanetRadius * 0.0012;
  return exp(-altitude / scaleHeight);
}

float opticalDepth(vec3 origin, vec3 direction, float maxDist) {
  float stepSize = maxDist / float(LIGHT_SAMPLES);
  float depth = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= LIGHT_SAMPLES) break;
    float t = stepSize * (float(i) + 0.5);
    vec3 samplePos = origin + direction * t;
    float r = length(samplePos) - uPlanetRadius;
    depth += densityAtAltitude(r) * stepSize;
  }
  return depth;
}

void main() {
  vec2 ndc = vUV * 2.0 - 1.0;
  vec4 nearW = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 farW  = uInvVP * vec4(ndc,  1.0, 1.0);
  nearW /= nearW.w;
  farW  /= farW.w;

  vec3 ro = uCameraPos - uPlanetCenter;
  vec3 rd = normalize(farW.xyz - nearW.xyz);

  vec2 atmoHit = hitSphere(ro, rd, uAtmosphereRadius);
  if (atmoHit.y < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 planetHit = hitSphere(ro, rd, uPlanetRadius);
  float tEnd = atmoHit.y;
  if (planetHit.x > 0.0) {
    tEnd = min(tEnd, planetHit.x);
  }

  float tStart = max(0.0, atmoHit.x);
  if (tStart >= tEnd) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float stepSize = (tEnd - tStart) / float(SAMPLES);
  vec3 sumRayleigh = vec3(0.0);
  float sumMie = 0.0;
  float opticalDepthCamera = 0.0;

  vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  float betaM = 21e-6;

  for (int i = 0; i < 16; i++) {
    if (i >= SAMPLES) break;
    float t = tStart + stepSize * (float(i) + 0.5);
    vec3 samplePos = ro + rd * t;
    float r = length(samplePos);
    float altitude = r - uPlanetRadius;
    float density = densityAtAltitude(altitude);

    opticalDepthCamera += density * stepSize;

    vec3 sunDir = normalize(uSunDirection);
    vec2 lightPlanetHit = hitSphere(samplePos, sunDir, uPlanetRadius);
    float inShadow = lightPlanetHit.x > 0.0 ? 0.0 : 1.0;
    float lightDepth = opticalDepth(samplePos, sunDir, uAtmosphereRadius - r) * inShadow;

    vec3 attn = exp(-(betaR * (opticalDepthCamera + lightDepth) + vec3(betaM) * (opticalDepthCamera + lightDepth) * 1.1));

    sumRayleigh += density * attn * stepSize;
    sumMie += density * attn.r * stepSize;
  }

  float cosTheta = dot(rd, normalize(uSunDirection));
  vec3 scatter = sumRayleigh * betaR * rayleighPhase(cosTheta) +
                 vec3(sumMie * betaM * miePhase(cosTheta, 0.85) * 0.05);

  float sunGlow = pow(max(0.0, cosTheta), 256.0) * 2.0;
  sunGlow += pow(max(0.0, cosTheta), 32.0) * 0.1;

  float intensity = length(scatter);
  scatter += vec3(1.0, 0.95, 0.8) * sunGlow * exp(-opticalDepthCamera * 0.5);

  float horizonAngle = dot(normalize(ro), rd);
  float horizonGlow = pow(1.0 - abs(horizonAngle), 8.0) * 0.3;
  scatter += vec3(0.3, 0.5, 1.0) * horizonGlow;

  float alpha = smoothstep(0.0, 0.001, intensity) * 0.8;
  alpha += horizonGlow * 0.2;
  alpha = clamp(alpha, 0.0, 0.85);

  gl_FragColor = vec4(scatter, alpha);
}
