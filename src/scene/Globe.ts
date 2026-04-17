/**
 * Globe — Earth sphere with real NASA Blue Marble textures.
 * Loads actual Earth imagery instead of procedural patterns.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371; // km, arbitrary units

export function createGlobe(): { mesh: THREE.Mesh; onLoad: Promise<void> } {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  // Placeholder material while textures load
  const placeholderMat = new THREE.MeshStandardMaterial({
    color: 0x2255aa,
    roughness: 0.8,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(geometry, placeholderMat);
  mesh.name = 'globe';

  // Load real textures
  const loader = new THREE.TextureLoader();
  const textureBase = '/textures';

  const loadPromise = new Promise<void>((resolve) => {
    // Load color map (NASA Blue Marble 5400x2700)
    loader.load(`${textureBase}/earth_color_8k.jpg`, (colorMap) => {
      colorMap.colorSpace = THREE.SRGBColorSpace;
      colorMap.wrapS = THREE.RepeatWrapping;
      colorMap.wrapT = THREE.ClampToEdgeWrapping;
      colorMap.anisotropy = 4;

      // Generate roughness map from color (ocean detection)
      const roughnessMap = generateRoughnessFromColor(colorMap);

      // Apply to mesh
      const material = new THREE.MeshStandardMaterial({
        map: colorMap,
        roughnessMap: roughnessMap,
        roughness: 0.75,
        metalness: 0.01,
      });

      mesh.material = material;
      material.needsUpdate = true;

      resolve();
    });
  });

  return { mesh, onLoad: loadPromise };
}

/**
 * Generate a roughness map by detecting ocean pixels (blue-ish) from the color map.
 * Oceans = smooth (low roughness), Land = rough (high roughness).
 */
function generateRoughnessFromColor(colorMap: THREE.Texture): THREE.DataTexture {
  const img = colorMap.image as HTMLImageElement;
  const w = img.width;
  const h = img.height;

  // Draw image to canvas to read pixels
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, w, h).data;

  // Generate roughness at lower resolution
  const rw = 512;
  const rh = 256;
  const roughness = new Uint8Array(rw * rh * 4);

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      // Sample from source
      const sx = Math.floor((x / rw) * w);
      const sy = Math.floor((y / rh) * h);
      const si = (sy * w + sx) * 4;

      const r = pixels[si];
      const g = pixels[si + 1];
      const b = pixels[si + 2];

      // Simple ocean detection: blue dominance
      const isOcean = b > r * 1.3 && b > g * 1.1;

      // Ice/snow detection (high brightness, polar regions)
      const brightness = (r + g + b) / 3;
      const isIce = brightness > 200;

      let rough: number;
      if (isOcean) {
        // Ocean: very smooth with subtle wave pattern
        rough = 15 + Math.sin(x * 0.1 + y * 0.05) * 5;
      } else if (isIce) {
        // Ice: medium-smooth
        rough = 100;
      } else {
        // Land: rough
        rough = 180 + Math.sin(x * 0.05) * 20;
      }

      const idx = (y * rw + x) * 4;
      roughness[idx] = rough;
      roughness[idx + 1] = rough;
      roughness[idx + 2] = rough;
      roughness[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(roughness, rw, rh, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
