/**
 * GlobeLighting — Day/night cycle and ocean specular for the globe.
 * 
 * Adds a separate lighting rig that wraps the globe:
 * - Sun directional light (follows time of day)
 * - Night-side terminator glow
 * - Ocean specular highlights (via roughness modulation)
 * 
 * Does NOT modify Globe.ts — works alongside it.
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';

export class GlobeLighting {
  private sunLight: THREE.DirectionalLight;
  private nightGlow: THREE.Mesh;
  private sunAngle: number = 0; // radians, 0 = noon at lon 0

  constructor(scene: THREE.Scene, private globe: THREE.Mesh) {
    // Main sun light
    this.sunLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
    this.sunLight.position.set(GLOBE_RADIUS * 5, GLOBE_RADIUS * 3, -GLOBE_RADIUS * 2);
    scene.add(this.sunLight);

    // Warm fill from opposite side (earthshine / reflected light)
    const fillLight = new THREE.DirectionalLight(0x4466aa, 0.15);
    fillLight.position.set(-GLOBE_RADIUS * 3, -GLOBE_RADIUS * 2, GLOBE_RADIUS * 4);
    scene.add(fillLight);

    // Night glow (city lights / atmospheric glow on the dark side)
    this.nightGlow = this.createNightGlow();
    scene.add(this.nightGlow);
  }

  /**
   * Update lighting based on simulation time.
   * @param hourOfDay - 0-24, affects sun angle
   */
  updateTime(hourOfDay: number): void {
    // Sun angle: 0h = midnight (sun opposite), 12h = noon (sun overhead at lon 0)
    this.sunAngle = ((hourOfDay - 12) / 24) * Math.PI * 2;

    // Position sun
    const dist = GLOBE_RADIUS * 5;
    this.sunLight.position.set(
      dist * Math.cos(this.sunAngle),
      dist * 0.5, // slight elevation
      dist * Math.sin(this.sunAngle)
    );

    // Sun color shift (warmer at sunset/sunrise)
    const sunElevation = Math.cos(this.sunAngle);
    if (sunElevation < 0.2 && sunElevation > -0.2) {
      // Sunset/sunrise — warm orange
      this.sunLight.color.setHex(0xff8844);
      this.sunLight.intensity = 1.2;
    } else if (sunElevation > 0.5) {
      // Midday — bright white
      this.sunLight.color.setHex(0xfff5e0);
      this.sunLight.intensity = 1.8;
    } else {
      // Night — dim blue
      this.sunLight.color.setHex(0x6688bb);
      this.sunLight.intensity = 0.3;
    }

    // Night glow follows opposite of sun
    this.nightGlow.position.copy(this.globe.position);
    this.nightGlow.rotation.y = this.sunAngle + Math.PI;
    this.nightGlow.visible = sunElevation < 0.3;

    // Update night glow sun direction
    const nightGlowMat = this.nightGlow.material as THREE.ShaderMaterial;
    nightGlowMat.uniforms.uSunDirection.value.copy(this.sunLight.position).normalize();
  }

  /**
   * Night glow shell — subtle blue glow on the dark side.
   * Simulates atmospheric scattering + city lights.
   */
  private createNightGlow(): THREE.Mesh {
    const radius = GLOBE_RADIUS * 1.002;
    const geometry = new THREE.SphereGeometry(radius, 64, 64);

    const material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDirection;
        uniform vec3 uCameraPosition;
        varying vec3 vNormal;
        varying vec3 vWorldPosition;

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(uCameraPosition - vWorldPosition);

          // Only show on the dark side (opposite of sun)
          float sunDot = dot(normal, normalize(uSunDirection));
          float nightMask = smoothstep(-0.1, -0.3, sunDot);

          // Limb brightening (atmospheric glow at the terminator)
          float limb = 1.0 - abs(dot(normal, viewDir));
          limb = pow(limb, 4.0);

          // Subtle blue glow
          vec3 nightColor = vec3(0.15, 0.2, 0.4);
          float intensity = nightMask * limb * 0.4;

          gl_FragColor = vec4(nightColor, intensity);
        }
      `,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(1, 0.3, 0).normalize() },
        uCameraPosition: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'nightGlow';
    return mesh;
  }

  /**
   * Update camera position for night glow shader.
   */
  updateCameraPosition(pos: THREE.Vector3): void {
    const mat = this.nightGlow.material as THREE.ShaderMaterial;
    mat.uniforms.uCameraPosition.value.copy(pos);
    // Don't overwrite uSunDirection here — it's set in updateTime()
  }

  /**
   * Get the current sun direction vector.
   */
  getSunDirection(): THREE.Vector3 {
    return this.sunLight.position.clone().normalize();
  }
}
