/**
 * UI — Time slider, level selector, layer toggles, camera mode.
 */

import type { WeatherManager } from '../weather/WeatherManager';
import type { WeatherLevel, WeatherLayer } from '../weather/types';
import type { CameraMode } from '../scene/Camera';

interface UIActions {
  onTimeChange: (timestamp: number) => void;
  onLevelChange: (level: WeatherLevel) => void;
  onLayerToggle: (layer: WeatherLayer, active: boolean) => void;
  onCameraMode: (mode: CameraMode) => void;
}

export function createUI(container: HTMLElement, weather: WeatherManager, actions: UIActions) {
  container.innerHTML = `
    <div class="aeris-ui">
      <div class="ui-panel time-panel">
        <label>Time</label>
        <input type="range" id="time-slider" min="0" max="72" value="0" step="1" />
        <span id="time-display">Now</span>
      </div>

      <div class="ui-panel level-panel">
        <label>Level</label>
        <div class="level-buttons">
          <button class="level-btn active" data-level="surface">SFC</button>
          <button class="level-btn" data-level="850hPa">850</button>
          <button class="level-btn" data-level="500hPa">500</button>
          <button class="level-btn" data-level="FL100">FL100</button>
          <button class="level-btn" data-level="FL200">FL200</button>
          <button class="level-btn" data-level="FL300">FL300</button>
        </div>
      </div>

      <div class="ui-panel layers-panel">
        <label>Layers</label>
        <div class="layer-toggles">
          <button class="layer-btn active" data-layer="wind">💨 Wind</button>
          <button class="layer-btn active" data-layer="clouds">☁️ Clouds</button>
          <button class="layer-btn" data-layer="temperature">🌡️ Temp</button>
          <button class="layer-btn" data-layer="pressure">📊 Pressure</button>
          <button class="layer-btn" data-layer="humidity">💧 Humidity</button>
        </div>
      </div>

      <div class="ui-panel camera-panel">
        <label>Camera</label>
        <button class="cam-btn active" data-mode="orbit">🌍 Orbit</button>
        <button class="cam-btn" data-mode="freeflight">✈️ Free Flight</button>
      </div>
    </div>
  `;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .aeris-ui {
      display: flex;
      gap: 16px;
      padding: 16px;
      background: linear-gradient(transparent, rgba(0,0,0,0.7));
      flex-wrap: wrap;
      align-items: flex-end;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e0e8f0;
      font-size: 13px;
    }
    .ui-panel {
      background: rgba(10, 20, 40, 0.8);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(100, 140, 200, 0.2);
      border-radius: 8px;
      padding: 10px 14px;
    }
    .ui-panel label {
      display: block;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: rgba(160, 190, 230, 0.6);
      margin-bottom: 6px;
    }
    #time-slider {
      width: 200px;
      accent-color: #4a90d9;
    }
    #time-display {
      margin-left: 8px;
      font-variant-numeric: tabular-nums;
      color: #8ab4e8;
    }
    .level-buttons, .layer-toggles {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .level-btn, .layer-btn, .cam-btn {
      background: rgba(40, 60, 100, 0.5);
      border: 1px solid rgba(80, 120, 180, 0.3);
      border-radius: 4px;
      color: #a0c0e0;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s;
    }
    .level-btn:hover, .layer-btn:hover, .cam-btn:hover {
      background: rgba(60, 90, 150, 0.6);
    }
    .level-btn.active, .cam-btn.active {
      background: rgba(70, 130, 220, 0.6);
      border-color: rgba(100, 160, 255, 0.5);
      color: #fff;
    }
    .layer-btn.active {
      background: rgba(60, 160, 100, 0.5);
      border-color: rgba(80, 200, 120, 0.4);
      color: #fff;
    }
  `;
  document.head.appendChild(style);

  // --- Event wiring ---

  // Time slider
  const timeSlider = container.querySelector('#time-slider') as HTMLInputElement;
  const timeDisplay = container.querySelector('#time-display')!;
  timeSlider.addEventListener('input', () => {
    const hours = parseInt(timeSlider.value);
    const now = new Date();
    now.setHours(now.getHours() + hours);
    timeDisplay.textContent = hours === 0 ? 'Now' : `+${hours}h`;
    actions.onTimeChange(now.getTime());
  });

  // Level buttons
  container.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onLevelChange(btn.getAttribute('data-level') as WeatherLevel);
    });
  });

  // Layer toggles
  container.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.getAttribute('data-layer') as WeatherLayer;
      const isActive = btn.classList.toggle('active');
      actions.onLayerToggle(layer, isActive);
    });
  });

  // Camera mode
  container.querySelectorAll('.cam-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onCameraMode(btn.getAttribute('data-mode') as CameraMode);
    });
  });

  return { container };
}
