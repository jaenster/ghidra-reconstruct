/**
 * Transform Plugin Registry
 *
 * Central registry for managing transform plugins and creating pipelines.
 */

import * as crypto from 'node:crypto';
import type {
  TransformPlugin,
  PluginOptions,
  PipelineOptions,
  EnabledOptions,
  PluginRegistryEvent,
  PluginRegistryListener,
  InjectionContext,
} from './types.js';
import type { Transformer } from '../transformer.js';
import { TransformPipeline, type TransformStep } from '../pipeline.js';
import { InjectionCollector } from './injection.js';
import type { ASTNode } from '../../ast/nodes.js';

// ============================================
// PLUGIN REGISTRY
// ============================================

/**
 * Registry for managing transform plugins
 */
export class PluginRegistry {
  private plugins = new Map<string, TransformPlugin>();
  private enabledState = new Map<string, boolean>();
  private listeners: PluginRegistryListener[] = [];

  /**
   * Register a plugin
   */
  register(plugin: TransformPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }

    // Validate dependencies exist
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          console.warn(`Plugin ${plugin.id} depends on unregistered plugin: ${dep}`);
        }
      }
    }

    this.plugins.set(plugin.id, plugin);
    this.enabledState.set(plugin.id, plugin.defaultEnabled);

    this.emit({ type: 'register', pluginId: plugin.id, plugin });
  }

  /**
   * Unregister a plugin
   */
  unregister(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      return;
    }

    this.plugins.delete(id);
    this.enabledState.delete(id);

    this.emit({ type: 'unregister', pluginId: id, plugin });
  }

  /**
   * Get a plugin by ID
   */
  get(id: string): TransformPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all registered plugins
   */
  getAll(): TransformPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Check if a plugin is registered
   */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /**
   * Enable or disable a plugin
   */
  setEnabled(id: string, enabled: boolean): void {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error(`Plugin not found: ${id}`);
    }

    const wasEnabled = this.enabledState.get(id);
    if (wasEnabled !== enabled) {
      this.enabledState.set(id, enabled);
      this.emit({ type: enabled ? 'enable' : 'disable', pluginId: id, plugin });
    }
  }

  /**
   * Check if a plugin is enabled
   */
  isEnabled(id: string): boolean {
    return this.enabledState.get(id) ?? false;
  }

  /**
   * Get all enabled plugins, sorted by priority
   */
  getEnabled(options: EnabledOptions = {}): TransformPlugin[] {
    const { tags, excludeTags, preset } = options as { tags?: string[]; excludeTags?: string[]; preset?: 'quick' | 'full' };

    let plugins = Array.from(this.plugins.values()).filter((p) => {
      // Check if enabled (considering preset)
      let isEnabled = this.enabledState.get(p.id) ?? p.defaultEnabled;

      // Override with preset defaults
      if (preset === 'quick') {
        // Quick preset: only core plugins
        isEnabled = p.tags?.includes('core') ?? false;
      } else if (preset === 'full') {
        // Full preset: all plugins enabled by default
        isEnabled = true;
      }

      // Filter by tags
      if (tags && tags.length > 0) {
        if (!p.tags?.some((t) => tags.includes(t))) {
          return false;
        }
      }

      // Exclude by tags
      if (excludeTags && excludeTags.length > 0) {
        if (p.tags?.some((t) => excludeTags.includes(t))) {
          return false;
        }
      }

      return isEnabled;
    });

    // Sort by priority (lower = earlier)
    plugins.sort((a, b) => a.priority - b.priority);

    // Check incompatibilities
    const enabledIds = new Set(plugins.map((p) => p.id));
    plugins = plugins.filter((p) => {
      if (p.incompatibleWith) {
        for (const incompatId of p.incompatibleWith) {
          if (enabledIds.has(incompatId)) {
            console.warn(
              `Plugin ${p.id} is incompatible with ${incompatId}, disabling ${p.id}`
            );
            return false;
          }
        }
      }
      return true;
    });

    return plugins;
  }

  /**
   * Create a transformation pipeline from enabled plugins
   */
  createPipeline<N extends ASTNode = ASTNode>(
    options: PipelineOptions = {}
  ): TransformPipeline<N> {
    const {
      preset = 'quick',
      enablePlugins,
      disablePlugins,
      pluginOptions = {},
      trackSteps = false,
    } = options;

    // Get base enabled plugins
    // 'custom' preset means use current enabled state without preset override
    let plugins = this.getEnabled({ preset: preset === 'custom' ? undefined : preset });

    // Apply explicit enable/disable overrides
    if (enablePlugins) {
      for (const id of enablePlugins) {
        const plugin = this.plugins.get(id);
        if (plugin && !plugins.find((p) => p.id === id)) {
          plugins.push(plugin);
        }
      }
      // Re-sort after adding
      plugins.sort((a, b) => a.priority - b.priority);
    }

    if (disablePlugins) {
      plugins = plugins.filter((p) => !disablePlugins.includes(p.id));
    }

    // Create shared injection collector
    const collector = new InjectionCollector();

    // Collect static injections from enabled plugins
    for (const plugin of plugins) {
      if (plugin.staticInjections) {
        for (const injection of plugin.staticInjections) {
          collector.inject(injection);
        }
      }
    }

    // Create pipeline steps — use injection transformer when available
    const steps: TransformStep<N>[] = plugins.map((plugin) => {
      const opts = pluginOptions[plugin.id];

      if (plugin.createInjectionTransformer) {
        // Wrap injection transformer to pass the shared collector
        const injTransformer = plugin.createInjectionTransformer(opts);
        const wrappedTransformer: Transformer<N> = ((node: ASTNode) =>
          injTransformer(node, collector)) as unknown as Transformer<N>;

        return {
          name: plugin.id,
          description: plugin.description,
          enabled: true,
          transform: wrappedTransformer,
        };
      }

      return {
        name: plugin.id,
        description: plugin.description,
        enabled: true,
        transform: plugin.createTransformer(opts) as unknown as Transformer<N>,
      };
    });

    const pipeline = new TransformPipeline<N>(steps, { trackSteps });
    pipeline.injectionCollector = collector;
    return pipeline;
  }

  /**
   * Create a single transformer from enabled plugins
   */
  createTransformer(options: PipelineOptions = {}): Transformer {
    const pipeline = this.createPipeline(options);
    return pipeline.toTransformer();
  }

  /**
   * Get a hash of the versions of the specified plugins
   * Used for cache invalidation
   */
  getVersionHash(pluginIds?: string[]): string {
    const ids = pluginIds ?? Array.from(this.plugins.keys()).sort();
    const versions: string[] = [];

    for (const id of ids) {
      const plugin = this.plugins.get(id);
      if (plugin) {
        versions.push(`${id}:${plugin.version}`);
      }
    }

    const hash = crypto.createHash('md5').update(versions.join('|')).digest('hex');
    return hash.slice(0, 12);
  }

  /**
   * Get plugin IDs that are currently enabled
   */
  getEnabledIds(options: PipelineOptions = {}): string[] {
    const preset = options.preset === 'custom' ? undefined : options.preset;
    return this.getEnabled({ preset }).map((p) => p.id);
  }

  /**
   * Add a listener for registry events
   */
  addListener(listener: PluginRegistryListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: PluginRegistryListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(event: PluginRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Plugin registry listener error:', error);
      }
    }
  }

  /**
   * Clear all registered plugins
   */
  clear(): void {
    for (const id of this.plugins.keys()) {
      this.unregister(id);
    }
  }

  /**
   * Get plugin count
   */
  get size(): number {
    return this.plugins.size;
  }
}

// ============================================
// DEFAULT REGISTRY
// ============================================

/**
 * Global default registry instance
 * Built-in plugins will be registered here
 */
export const defaultRegistry = new PluginRegistry();

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create a simple plugin from a transformer function
 */
export function createPlugin(
  id: string,
  name: string,
  description: string,
  createTransformer: (options?: PluginOptions) => Transformer,
  options: Partial<Omit<TransformPlugin, 'id' | 'name' | 'description' | 'createTransformer'>> = {}
): TransformPlugin {
  return {
    id,
    name,
    description,
    version: options.version ?? '1.0.0',
    defaultEnabled: options.defaultEnabled ?? true,
    priority: options.priority ?? 100,
    tags: options.tags,
    createTransformer,
    asmPatterns: options.asmPatterns,
    dependencies: options.dependencies,
    incompatibleWith: options.incompatibleWith,
  };
}

/**
 * Register multiple plugins at once
 */
export function registerPlugins(
  registry: PluginRegistry,
  plugins: TransformPlugin[]
): void {
  for (const plugin of plugins) {
    registry.register(plugin);
  }
}
