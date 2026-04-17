// cloud.frag — Windy-style blue cloud overlay for MapLibre globe
//
// Renders cloud coverage as a semi-transparent blue-tinted layer
// on the globe surface. No volumetric ray-marching — just a clean
// 2D cloud map with noise detail and blue color grading.

#version 300 es
precision highp float;

uniform mat4 uInvVP;
uniform vec3 uCameraPos;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudBaseAlt;
uniform float uCloudTopAlt;
uniform float uTime;
uniform float uCoverageMult;
uniform float uOpacity;
uniform sampler2D uCloudMap;
uniform sampler3D uNoiseTex;

in vec2 vUV;
out vec4 fragColor;

#define PI 3.14159265359
#define MAX_STEPS 48

// Ray-sphere intersection
vec2 hitSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// World position → equirectangular UV
vec2 worldToLatLonUV(vec3 worldPos) {
  vec3 dir = normalize(worldPos - uPlanetCenter);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  float lon = atan(dir.z, dir.x);
  return vec2(
    (lon / (2.0 * PI)) + 0.5,
    (lat / PI) + 0.5
  );
}

// Sample 3D noise with wind drift
float sampleNoise(vec3 worldPos, float scale) {
  vec3 p = worldPos * scale;
  p.x += uTime * 0.00015;
  p.z += uTime * 0.0001;
  p = fract(p);
  return texture(uNoiseTex, p).r;
}

// Henyey-Greenstein phase
float phase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

void main() {
  // Reconstruct world ray from screen UV
  vec2 ndc = vUV * 2.0 - 1.0;
  vec4 nearW = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 farW  = uInvVP * vec4(ndc,  1.0, 1.0);
  nearW /= nearW.w;
  farW  /= farW.w;

  vec3 ro = uCameraPos - uPlanetCenter;
  vec3 rd = normalize(farW.xyz - nearW.xyz);

  // Intersect with cloud shell (between base and top altitude)
  float cloudMid = uPlanetRadius + (uCloudBaseAlt + uCloudTopAlt) * 0.5;
  float cloudThick = uCloudTopAlt - uCloudBaseAlt;

  vec2 hit = hitSphere(ro, rd, cloudMid);
  if (hit.y < 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  float tStart = max(0.0, hit.x);
  float tEnd = hit.y;

  // Also check planet intersection — don't render clouds behind the surface
  vec2 planetHit = hitSphere(ro, rd, uPlanetRadius);
  if (planetHit.x > 0.0) {
    tEnd = min(tEnd, planetHit.x);
  }

  if (tStart >= tEnd) {
    fragColor = vec4(0.0);
    return;
  }

  // Sample at the midpoint (single sample — fast, no banding)
  float tMid = (tStart + tEnd) * 0.5;
  vec3 pos = ro + rd * tMid;
  vec3 worldPos = pos + uPlanetCenter;

  // Cloud coverage from weather data
  vec2 uv = worldToLatLonUV(worldPos);
  vec4 cloudData = texture(uCloudMap, uv);
  float coverage = cloudData.r * uCoverageMult;
  float humidity = cloudData.g;

  // Skip if no coverage
  if (coverage < 0.01) {
    fragColor = vec4(0.0);
    return;
  }

  // 3D noise for detail
  float n1 = sampleNoise(pos, 0.0003);
  float n2 = sampleNoise(pos, 0.0015);
  float noise = n1 * 0.6 + n2 * 0.4;

  // Height factor — clouds are thicker in the middle of the layer
  float alt = length(pos) - uPlanetRadius;
  float h = clamp((alt - uCloudBaseAlt) / cloudThick, 0.0, 1.0);
  float heightMask = smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.75, 1.0, h));

  // Final cloud density
  float density = coverage * noise * heightMask;
  density = smoothstep(0.08, 0.5, density); // threshold for cloud edges

  if (density < 0.01) {
    fragColor = vec4(0.0);
    return;
  }

  // ── Windy Blue Mode Color Grading ──
  // Sun direction
  vec3 sunDir = normalize(vec3(0.6, 0.8, -0.4));
  vec3 viewDir = normalize(uCameraPos - worldPos);

  // Phase function for forward scattering
  float cosTheta = dot(-rd, sunDir);
  float pf = mix(phase(cosTheta, -0.2), phase(cosTheta, 0.6), 0.7);

  // Blue palette: deep blue → light blue → white
  vec3 deepBlue  = vec3(0.08, 0.15, 0.35);  // shadow / thick cloud
  vec3 midBlue   = vec3(0.35, 0.55, 0.85);   // mid-lit
  vec3 lightBlue = vec3(0.7, 0.82, 0.95);    // sun-lit edge
  vec3 white     = vec3(0.95, 0.97, 1.0);    // bright highlight

  // Mix colors based on density and lighting
  float lighting = pf * 1.5 + 0.15; // ambient + scattering
  lighting = clamp(lighting, 0.0, 1.5);

  vec3 cloudColor;
  if (density < 0.3) {
    // Thin edges — light blue to white
    cloudColor = mix(lightBlue, white, lighting * 0.6);
  } else if (density < 0.7) {
    // Medium — blue tones
    cloudColor = mix(midBlue, lightBlue, lighting * 0.5);
  } else {
    // Thick — deep blue to mid blue
    cloudColor = mix(deepBlue, midBlue, lighting * 0.4);
  }

  // Add slight silver lining on bright edges
  float silverLining = pow(max(0.0, lighting - 0.8), 2.0) * 0.5;
  cloudColor += vec3(silverLining);

  // Humidity influence — more humid = slightly more opaque
  float alphaBoost = mix(1.0, 1.3, humidity);

  // Final alpha — scaled by density and view angle
  float alpha = density * uOpacity * alphaBoost;
  alpha *= smoothstep(0.0, 0.05, density); // soft edges

  // Fade out when very close to cloud layer (avoid z-fighting with globe)
  float viewDist = length(ro);
  float distToCloud = abs(viewDist - cloudMid);
  float fadeNear = smoothstep(0.0, cloudThick * 0.5, distToCloud);
  alpha *= fadeNear;

  fragColor = vec4(cloudColor, alpha);
}
