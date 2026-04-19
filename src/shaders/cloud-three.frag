// cloud-three.frag — Volumetric cloud shader (GLSL 100)
//
// Optimizations:
// - Single-channel noise texture (Red format, not RGBA)
// - Removed inner sphere intersection (camera is always outside cloud shell)
// - Adaptive empty-space skipping for zero-coverage regions
// - Reduced loop overhead with early-exit transmittance check

#define PI 3.14159265359

uniform sampler2D uCloudMap;
uniform sampler3D uNoiseTex;

uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudTop;

uniform float uTime;
uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;

uniform int uMaxSteps;
uniform int uLightSteps;
uniform float uDensityMultiplier;
uniform float uCoverageMultiplier;
uniform vec2 uWindVelocity;

varying vec3 vWorldPosition;

// Henyey-Greenstein phase function
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Dual-lobe phase (forward + backward scattering)
float phase(float cosTheta) {
  float forward = henyeyGreenstein(cosTheta, 0.7);
  float back = henyeyGreenstein(cosTheta, -0.35);
  return mix(back, forward, 0.6);
}

// World position to lat-lon UV
vec2 worldToUV(vec3 worldPos) {
  vec3 rel = normalize(worldPos - uPlanetCenter);
  float lat = asin(clamp(rel.y, -1.0, 1.0));
  float lon = atan(rel.z, rel.x);
  return vec2(
    (lon / (2.0 * PI)) + 0.5,
    (lat / PI) + 0.5
  );
}

// Sample cloud coverage from weather map (quick check before full noise)
float sampleCoverageQuick(vec3 worldPos) {
  vec2 uv = worldToUV(worldPos);
  float c = texture(uCloudMap, uv).r;
  return c * uCoverageMultiplier;
}

// Sample 3D noise with wind animation — single channel (.r)
float sampleNoise(vec3 worldPos, float scale) {
  vec3 uv = worldPos * scale + vec3(
    uTime * uWindVelocity.x,
    0.0,
    uTime * uWindVelocity.y
  );
  uv = fract(uv);
  return texture(uNoiseTex, uv).r;  // Single channel — was .r reading from RGBA
}

// Full density at a point
float getDensity(vec3 worldPos) {
  vec3 rel = worldPos - uPlanetCenter;
  float r = length(rel);
  float altitude = r - uPlanetRadius;

  if (altitude < uCloudBase || altitude > uCloudTop) return 0.0;

  float cloudRange = uCloudTop - uCloudBase;
  float h = (altitude - uCloudBase) / cloudRange;
  
  // Height falloff — bottom: gradual onset, middle: peak, top: gradual dissipation
  float heightShape = smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.6, 1.0, h));
  heightShape *= 0.7 + 0.3 * smoothstep(0.2, 0.5, h) * (1.0 - smoothstep(0.5, 0.8, h));

  float coverage = sampleCoverageQuick(worldPos);

  // Multi-octave noise for detail
  float n1 = sampleNoise(worldPos, 0.0004);
  float n2 = sampleNoise(worldPos, 0.002);
  float n3 = sampleNoise(worldPos, 0.008);
  float noise = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;

  float density = coverage * heightShape * noise;
  density *= uDensityMultiplier;
  density = smoothstep(0.02, 0.45, density);

  return density;
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

void main() {
  vec3 ro = uCameraPosition - uPlanetCenter;
  vec3 rd = normalize(vWorldPosition - uCameraPosition);

  // Only need the outer sphere — camera is always outside cloud layer
  vec2 outerHit = hitSphere(ro, rd, uCloudTop);

  if (outerHit.y < 0.0) {
    discard;
  }

  float tNear = max(0.0, outerHit.x);
  float tFar = outerHit.y;

  // Clamp march to cloud layer thickness (no inner sphere needed)
  float cloudTopR = uCloudTop;
  float cloudBaseR = uCloudBase;
  float maxMarchLen = (cloudTopR - cloudBaseR) * 1.2; // Slight overshoot is fine
  float marchLen = tFar - tNear;
  if (marchLen > maxMarchLen) {
    marchLen = maxMarchLen;
    tFar = tNear + marchLen;
  }

  if (tNear >= tFar) {
    discard;
  }

  // Blue noise dithering to reduce banding
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  tNear += dither * marchLen / float(uMaxSteps);

  float transmittance = 1.0;
  vec3 lightEnergy = vec3(0.0);

  for (int i = 0; i < 64; i++) {
    if (i >= uMaxSteps) break;
    if (transmittance < 0.01) break;

    float t = tNear + marchLen * (float(i) + 0.5) / float(uMaxSteps);
    vec3 pos = uCameraPosition + rd * t;

    // Empty-space skip: quick coverage check before full density evaluation
    float quickCov = sampleCoverageQuick(pos);
    if (quickCov < 0.01) continue; // Skip this step entirely

    float density = getDensity(pos);

    if (density > 0.001) {
      float stepLen = marchLen / float(uMaxSteps);
      float extinction = density * stepLen;
      transmittance *= exp(-extinction);

      // Light march (self-shadowing)
      float lightDensity = 0.0;
      float lightStep = 400.0;
      for (int j = 0; j < 8; j++) {
        if (j >= uLightSteps) break;
        vec3 lp = pos + uSunDirection * float(j) * lightStep;
        lightDensity += getDensity(lp) * lightStep * 0.5;
      }
      float lightTrans = exp(-lightDensity * 0.3);

      float cosTheta = dot(rd, uSunDirection);
      float pf = phase(cosTheta);

      // Silver lining (backlit cloud edges)
      float silver = 0.0;
      if (cosTheta < -0.2) {
        silver = pow(max(0.0, -cosTheta - 0.2) / 0.8, 2.0) * 0.6;
      }

      vec3 scatter = uSunColor * (lightTrans * pf + silver);
      vec3 ambient = vec3(0.35, 0.45, 0.65) * 0.15;
      lightEnergy += transmittance * extinction * (scatter + ambient);
    }
  }

  float alpha = 1.0 - transmittance;
  alpha = smoothstep(0.0, 0.03, alpha);

  // Discard fully transparent fragments to save blending cost
  if (alpha < 0.005) discard;

  gl_FragColor = vec4(lightEnergy, alpha);
}
