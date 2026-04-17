/**
 * Globe — Earth sphere with color + normal maps.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371; // km, arbitrary units

export function createGlobe(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  // TODO: Replace with actual earth textures
  // For now, use a basic material so the scene renders
  const material = new THREE.MeshPhongMaterial({
    color: 0x2255aa,
    specular: 0x111133,
    shininess: 15,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe';

  return mesh;
}
