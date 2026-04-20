/**
 * DeckLayerManager — Shared layer management for a single MapboxOverlay.
 *
 * Multiple layer classes (clouds, wind, rain) register/unregister their
 * deck.gl layers by ID. When any layer changes, the overlay is updated.
 */

import type { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';

export class DeckLayerManager {
  private overlay: MapboxOverlay;
  private layers: Map<string, Layer> = new Map();

  constructor(overlay: MapboxOverlay) {
    this.overlay = overlay;
  }

  setLayer(id: string, layer: Layer | null): void {
    if (layer) {
      this.layers.set(id, layer);
    } else {
      this.layers.delete(id);
    }
    this.overlay.setProps({ layers: Array.from(this.layers.values()) });
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
    this.overlay.setProps({ layers: Array.from(this.layers.values()) });
  }
}
