/**
 * UI — Time slider, level selector, layer toggles, camera mode.
 * 
 * v2: Responsive layout, loading indicator, FPS counter, better styling.
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
      <!-- Loading overlay -->
      <div class="loading-overlay" id="loading-overlay">
        <div class="loading-spinner"></div>
        <span>Loading weather data...</span>
      </div>

      <!-- Top bar: title + FPS -->
      <div class="top-bar">
        <div class="title">
          <span class="title-icon">🌍</span>
          <span class="title-text">AerisWeather</span>
        </div>
        <div class="fps-counter" id="fps-counter">-- FPS</div>
      </div>

      <!-- Bottom controls -->
      <div class="bottom-controls">
        <div class="ui-panel time-panel">
          <label>Forecast</label>
          <div class="time-row">
            <input type="range" id="time-slider" min="0" max="72" value="0" step="3" />
            <span id="time-display" class="time-value">Now</span>
          </div>
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
          <div class="camera-buttons">
            <button class="cam-btn active" data-mode="orbit">🌍 Orbit</button>
            <button class="cam-btn" data-mode="freeflight">✈️ Free</button>
          </div>
        </div>

        <!-- Legend (shown when weather layer active) -->
        <div class="ui-panel legend-panel hidden" id="legend-panel">
          <label id="legend-title">Temperature</label>
          <div class="legend-bar" id="legend-bar"></div>
          <div class="legend-labels">
            <span id="legend-min">-40°C</span>
            <span id="legend-max">40°C</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .aeris-ui {
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, -sans-serif;
      color: #e0e8f0;
      font-size: 13px;
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
    }
    .aeris-ui > * { pointer-events: auto; }

    /* Loading overlay */
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(0, 5, 15, 0.85);
      z-index: 100;
      transition: opacity 0.5s;
      gap: 16px;
      font-size: 16px;
      color: #8ab4e8;
    }
    .loading-overlay.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(100, 160, 255, 0.2);
      border-top-color: #4a90d9;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Top bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      pointer-events: none;
    }
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.3px;
      text-shadow: 0 2px 8px rgba(0,0,0,0.5);
    }
    .title-icon { font-size: 22px; }
    .title-text {
      background: linear-gradient(135deg, #8ab4e8, #c0d8f8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .fps-counter {
      font-size: 11px;
      font-family: 'SF Mono', 'Cascadia Code', monospace;
      color: rgba(160, 190, 230, 0.5);
      text-shadow: 0 1px 4px rgba(0,0,0,0.5);
    }

    /* Bottom controls */
    .bottom-controls {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      background: linear-gradient(transparent 0%, rgba(0,5,15,0.75) 30%);
      flex-wrap: wrap;
      align-items: flex-end;
      margin-top: auto;
    }
    .ui-panel {
      background: rgba(10, 20, 40, 0.8);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(100, 140, 200, 0.15);
      border-radius: 8px;
      padding: 8px 12px;
    }
    .ui-panel label {
      display: block;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: rgba(160, 190, 230, 0.5);
      margin-bottom: 4px;
    }

    /* Time slider */
    .time-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #time-slider {
      width: 160px;
      accent-color: #4a90d9;
      height: 4px;
    }
    .time-value {
      font-variant-numeric: tabular-nums;
      color: #8ab4e8;
      font-size: 12px;
      min-width: 40px;
    }

    /* Buttons */
    .level-buttons, .layer-toggles, .camera-buttons {
      display: flex;
      gap: 3px;
      flex-wrap: wrap;
    }
    .level-btn, .layer-btn, .cam-btn {
      background: rgba(40, 60, 100, 0.4);
      border: 1px solid rgba(80, 120, 180, 0.2);
      border-radius: 4px;
      color: #a0c0e0;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .level-btn:hover, .layer-btn:hover, .cam-btn:hover {
      background: rgba(60, 90, 150, 0.5);
      border-color: rgba(100, 150, 220, 0.3);
    }
    .level-btn.active, .cam-btn.active {
      background: rgba(70, 130, 220, 0.5);
      border-color: rgba(100, 160, 255, 0.4);
      color: #fff;
    }
    .layer-btn.active {
      background: rgba(60, 160, 100, 0.4);
      border-color: rgba(80, 200, 120, 0.3);
      color: #c0ffe0;
    }

    /* Responsive: stack vertically on narrow screens */
    @media (max-width: 768px) {
      .bottom-controls {
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px;
      }
      .ui-panel { padding: 6px 10px; }
      #time-slider { width: 100%; }
      .time-row { width: 100%; }
      .level-buttons, .layer-toggles, .camera-buttons {
        width: 100%;
        justify-content: flex-start;
      }
    }

    @media (max-width: 480px) {
      .title { font-size: 14px; }
      .title-icon { font-size: 18px; }
      .level-btn, .layer-btn, .cam-btn {
        padding: 3px 6px;
        font-size: 10px;
      }
    }

    /* Legend */
    .legend-panel {
      min-width: 120px;
    }
    .legend-panel.hidden { display: none; }
    .legend-bar {
      height: 12px;
      border-radius: 3px;
      margin: 4px 0 2px;
    }
    .legend-labels {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: rgba(160, 190, 230, 0.6);
    }
  `;
  document.head.appendChild(style);

  // --- Event wiring ---

  // Loading overlay
  const loadingOverlay = container.querySelector('#loading-overlay') as HTMLElement;
  weather.on('dataLoaded', () => {
    loadingOverlay.classList.add('hidden');
  });
  // Auto-hide after 3s if no data event
  setTimeout(() => loadingOverlay.classList.add('hidden'), 3000);

  // FPS counter
  const fpsCounter = container.querySelector('#fps-counter')!;
  let frameCount = 0;
  let lastFpsTime = performance.now();
  function updateFps() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
      fpsCounter.textContent = `${frameCount} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(updateFps);
  }
  updateFps();

  // Time slider
  const timeSlider = container.querySelector('#time-slider') as HTMLInputElement;
  const timeDisplay = container.querySelector('#time-display')!;
  timeSlider.addEventListener('input', () => {
    const hours = parseInt(timeSlider.value);
    timeDisplay.textContent = hours === 0 ? 'Now' : `+${hours}h`;
    const now = new Date();
    now.setHours(now.getHours() + hours);
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

  // Legend
  const legendPanel = container.querySelector('#legend-panel') as HTMLElement;
  const legendTitle = container.querySelector('#legend-title')!;
  const legendBar = container.querySelector('#legend-bar') as HTMLElement;
  const legendMin = container.querySelector('#legend-min')!;
  const legendMax = container.querySelector('#legend-max')!;

  const legendConfig: Record<string, { title: string; gradient: string; min: string; max: string }> = {
    temperature: {
      title: 'Temperature',
      gradient: 'linear-gradient(90deg, #0066cc, #88ccff, #ffffff, #ffcc44, #ff4400)',
      min: '-40°C',
      max: '40°C',
    },
    pressure: {
      title: 'Pressure',
      gradient: 'linear-gradient(90deg, #6633aa, #3366cc, #33cc88, #cccc00)',
      min: '980 hPa',
      max: '1040 hPa',
    },
    humidity: {
      title: 'Humidity',
      gradient: 'linear-gradient(90deg, #886633, #44aa44, #2266aa)',
      min: '0%',
      max: '100%',
    },
  };

  function updateLegend(layer: string) {
    const config = legendConfig[layer];
    if (config) {
      legendPanel.classList.remove('hidden');
      legendTitle.textContent = config.title;
      legendBar.style.background = config.gradient;
      legendMin.textContent = config.min;
      legendMax.textContent = config.max;
    }
  }

  // Layer toggles
  container.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.getAttribute('data-layer') as WeatherLayer;
      const isActive = btn.classList.toggle('active');
      actions.onLayerToggle(layer, isActive);

      // Show/hide legend
      if (isActive && legendConfig[layer]) {
        updateLegend(layer);
      } else if (!isActive && legendConfig[layer]) {
        // Check if any other legend-able layer is active
        const hasLegendLayer = Array.from(container.querySelectorAll('.layer-btn.active'))
          .some(b => legendConfig[b.getAttribute('data-layer')!]);
        if (!hasLegendLayer) {
          legendPanel.classList.add('hidden');
        } else {
          // Show first active legend layer
          const first = Array.from(container.querySelectorAll('.layer-btn.active'))
            .find(b => legendConfig[b.getAttribute('data-layer')!]);
          if (first) updateLegend(first.getAttribute('data-layer')!);
        }
      }
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
