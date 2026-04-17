/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 */

import { createScene } from './scene/Scene';
import { createGlobe } from './scene/Globe';
import { createAtmosphere } from './scene/Atmosphere';
import { createCamera } from './scene/Camera';
import { createSkybox } from './scene/Skybox';
import { GlobeLighting } from './scene/GlobeLighting';
import { WeatherManager } from './weather/WeatherManager';
import { WeatherOverlay } from './weather/WeatherOverlay';
import { CloudRenderer } from './clouds/CloudRenderer';
import { WindParticles } from './wind/WindParticles';
import { createUI } from './ui/UI';
import * as THREE from 'three';

async function init() {
  const container = document.getElementById('app')!;
  const uiContainer = document.getElementById('ui-overlay')!;

  // Core scene
  const { renderer, scene } = createScene(container);

  // Starfield skybox
  const stars = createSkybox();
  scene.add(stars);

  // Globe (procedural earth textures by AgentA)
  const globe = createGlobe();
  scene.add(globe);

  // Globe lighting (day/night cycle + night glow)
  const globeLighting = new GlobeLighting(scene, globe);

  // Atmosphere shell (Group with main + inner meshes)
  const atmosphereGroup = createAtmosphere();
  scene.add(atmosphereGroup);

  // Collect atmosphere shader materials for uniform updates
  const atmosphereMaterials: THREE.ShaderMaterial[] = [];
  atmosphereGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) {
      atmosphereMaterials.push(child.material);
    }
  });

  // Camera (orbit + free-flight + touch)
  const camera = createCamera(container);

  // Weather data manager
  const weather = new WeatherManager();

  // Volumetric clouds (half-res render + upscale)
  const clouds = new CloudRenderer(scene, weather);

  // Weather data overlays (temperature, pressure, humidity)
  const weatherOverlay = new WeatherOverlay(scene, weather);

  // Wind particles
  const wind = new WindParticles(scene, weather);

  // UI controls
  const ui = createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => weather.toggleLayer(layer, active),
    onCameraMode: (mode) => camera.setMode(mode),
  });

  // Globe auto-rotation — disabled until clouds are parented to globe
  let autoRotate = false;
  const ROTATION_SPEED = 0.00003;

  // --- Keyboard shortcuts ---
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        autoRotate = !autoRotate;
        break;
      case 'KeyR':
        // Reset camera to default orbit
        camera.setMode('orbit');
        break;
      case 'Digit1':
        weather.toggleLayer('wind', !weather.isLayerActive('wind'));
        break;
      case 'Digit2':
        weather.toggleLayer('clouds', !weather.isLayerActive('clouds'));
        break;
      case 'Digit3':
        weather.toggleLayer('temperature', !weather.isLayerActive('temperature'));
        break;
      case 'Digit4':
        weather.toggleLayer('pressure', !weather.isLayerActive('pressure'));
        break;
      case 'Digit5':
        weather.toggleLayer('humidity', !weather.isLayerActive('humidity'));
        break;
    }
  });

  // Stop auto-rotate when user interacts
  container.addEventListener('mousedown', () => { autoRotate = false; });
  container.addEventListener('wheel', () => { autoRotate = false; });

  // Render loop
  let lastTime = performance.now();
  let frameCount = 0;

  function animate(now: number) {
    requestAnimationFrame(animate);

    const dt = Math.min((now - lastTime) / 1000, 0.1); // cap dt
    lastTime = now;
    frameCount++;

    // Globe auto-rotation
    if (autoRotate) {
      globe.rotation.y += ROTATION_SPEED * (now - lastTime + dt * 1000);
    }

    camera.update(dt);
    weather.update(dt);
    clouds.update(dt, camera);

    // Only update wind every other frame (perf)
    if (frameCount % 2 === 0) {
      wind.update(dt * 2, camera);
    }

    // Update atmosphere uniforms
    for (const mat of atmosphereMaterials) {
      if (mat.uniforms.uCameraPosition) {
        mat.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);
      }
    }

    // Update globe lighting (slowly rotating sun)
    const hourOfDay = (Date.now() / 3600000) % 24;
    globeLighting.updateTime(hourOfDay);
    globeLighting.updateCameraPosition(camera.threeCamera.position);

    renderer.render(scene, camera.threeCamera);
  }

  // Kick off
  await weather.loadInitial();
  animate(performance.now());

  // Resize handling
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.threeCamera.aspect = w / h;
    camera.threeCamera.updateProjectionMatrix();
  });
}

init().catch(console.error);
