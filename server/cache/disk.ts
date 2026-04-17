/**
 * Disk cache for weather data.
 * Stores normalized grids as JSON, with TTL-based expiry.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CacheConfig {
  dir: string;
  ttlSeconds: number;
  maxSizeMB: number;
}

const DEFAULT_CONFIG: CacheConfig = {
  dir: './cache',
  ttlSeconds: 3600,
  maxSizeMB: 500,
};

export class DiskCache {
  private config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureDir(this.config.dir);
  }

  /**
   * Get cached data by key.
   */
  get<T>(key: string): T | null {
    const filePath = this.getPath(key);
    
    try {
      if (!fs.existsSync(filePath)) return null;
      
      const stat = fs.statSync(filePath);
      const age = (Date.now() - stat.mtimeMs) / 1000;
      
      if (age > this.config.ttlSeconds) {
        fs.unlinkSync(filePath);
        return null;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Store data by key.
   */
  set<T>(key: string, data: T): void {
    const filePath = this.getPath(key);
    const dir = path.dirname(filePath);
    
    this.ensureDir(dir);
    
    try {
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.warn(`[Cache] Write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Check if key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a cached entry.
   */
  delete(key: string): void {
    const filePath = this.getPath(key);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  /**
   * Clear expired entries.
   */
  prune(): number {
    let pruned = 0;
    
    try {
      this.walkDir(this.config.dir, (filePath) => {
        const stat = fs.statSync(filePath);
        const age = (Date.now() - stat.mtimeMs) / 1000;
        
        if (age > this.config.ttlSeconds) {
          fs.unlinkSync(filePath);
          pruned++;
        }
      });
    } catch {}

    return pruned;
  }

  /**
   * Get cache size in MB.
   */
  getSizeMB(): number {
    let total = 0;
    
    try {
      this.walkDir(this.config.dir, (filePath) => {
        total += fs.statSync(filePath).size;
      });
    } catch {}

    return total / (1024 * 1024);
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    try {
      fs.rmSync(this.config.dir, { recursive: true, force: true });
      this.ensureDir(this.config.dir);
    } catch {}
  }

  private getPath(key: string): string {
    // Sanitize key for filesystem
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.config.dir, `${safe}.json`);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private walkDir(dir: string, callback: (path: string) => void): void {
    if (!fs.existsSync(dir)) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        this.walkDir(fullPath, callback);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        callback(fullPath);
      }
    }
  }
}

// Export singleton
export const weatherCache = new DiskCache({ dir: './cache/weather' });
