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
import { CloudShadow } from './scene/CloudShadow';
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

  // Globe (procedural Earth with recognizable continents)
  const globe = createGlobe();
  scene.add(globe);

  // Globe lighting (day/night)
  const globeLighting = new GlobeLighting(scene, globe);

  // Atmosphere
  const atmosphereGroup = createAtmosphere();
  scene.add(atmosphereGroup);

  const atmosphereMaterials: THREE.ShaderMaterial[] = [];
  atmosphereGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) {
      atmosphereMaterials.push(child.material);
    }
  });

  // Camera
  const camera = createCamera(container);

  // Weather data
  const weather = new WeatherManager();

  // Clouds
  const clouds = new CloudRenderer(scene, weather);
  clouds.setVisible(true);

  // Cloud shadows
  const cloudShadow = new CloudShadow(scene, globe, weather);

  // Weather overlays
  const weatherOverlay = new WeatherOverlay(scene, weather);

  // Wind particles
  const wind = new WindParticles(scene, weather);

  // ── UI with proper layer toggle wiring ──────────────────────────────
  const ui = createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);

      // Actually update visuals!
      switch (layer) {
        case 'clouds':
          clouds.setVisible(active);
          cloudShadow.getMesh().visible = active;
          break;
        case 'wind':
          wind.setVisible(active);
          break;
        case 'temperature':
          weatherOverlay.setVisible('temperature', active);
          break;
        case 'pressure':
          weatherOverlay.setVisible('pressure', active);
          break;
        case 'humidity':
          weatherOverlay.setVisible('humidity', active);
          break;
      }
    },
    onCameraMode: (mode) => camera.setMode(mode),
  });

  // ── Globe auto-rotation ─────────────────────────────────────────────
  let autoRotate = true;
  let globeAngle = 0;

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        autoRotate = !autoRotate;
        break;
      case 'KeyR':
        camera.setMode('orbit');
        globeAngle = 0;
        globe.rotation.y = 0;
        break;
      case 'Digit1':
        document.getElementById('btn-wind')?.click();
        break;
      case 'Digit2':
        document.getElementById('btn-clouds')?.click();
        break;
      case 'Digit3':
        document.getElementById('btn-temp')?.click();
        break;
      case 'Digit4':
        document.getElementById('btn-pressure')?.click();
        break;
      case 'Digit5':
        document.getElementById('btn-humidity')?.click();
        break;
    }
  });

  container.addEventListener('mousedown', () => { autoRotate = false; });
  container.addEventListener('wheel', () => { autoRotate = false; });

  // ── Render loop ─────────────────────────────────────────────────────
  let lastTime = performance.now();
  let frameCount = 0;

  function animate(now: number) {
    requestAnimationFrame(animate);

    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    frameCount++;

    // Globe rotation
    if (autoRotate) {
      globeAngle += dt * 0.03; // slow spin
      globe.rotation.y = globeAngle;
      atmosphereGroup.rotation.y = globeAngle;
    }

    // Camera
    camera.update(dt);

    // Weather data update (interpolation)
    weather.update(dt);

    // Clouds
    clouds.update(dt, camera);

    // Wind particles (every other frame for perf)
    if (frameCount % 2 === 0) {
      wind.update(dt * 2, camera);
    }

    // Weather overlay
    weatherOverlay.update(dt);

    // Atmosphere uniforms
    for (const mat of atmosphereMaterials) {
      if (mat.uniforms.uCameraPosition) {
        mat.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);
      }
    }

    // Globe lighting
    const hourOfDay = (Date.now() / 3600000) % 24;
    globeLighting.updateTime(hourOfDay);
    globeLighting.updateCameraPosition(camera.threeCamera.position);

    // Cloud shadows
    cloudShadow.update(dt, globeLighting.getSunDirection());

    // Render
    renderer.render(scene, camera.threeCamera);
  }

  // ── Start ───────────────────────────────────────────────────────────
  await weather.loadInitial();
  animate(performance.now());

  // ── Resize ──────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.threeCamera.aspect = w / h;
    camera.threeCamera.updateProjectionMatrix();
    clouds.onResize();
  });
}

init().catch(console.error);
