/**
 * Plugin Registry Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  PluginRegistry,
  createPlugin,
  registerPlugins,
} from '../registry.js';
import type { TransformPlugin } from '../types.js';
import { identity } from '../../transformer.js';

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('register/unregister', () => {
    it('should register a plugin', () => {
      const plugin = createPlugin(
        'test-plugin',
        'Test Plugin',
        'A test plugin',
        () => identity
      );

      registry.register(plugin);

      assert.strictEqual(registry.has('test-plugin'), true);
      assert.strictEqual(registry.get('test-plugin'), plugin);
      assert.strictEqual(registry.size, 1);
    });

    it('should throw when registering duplicate', () => {
      const plugin = createPlugin('test', 'Test', 'Test', () => identity);
      registry.register(plugin);

      assert.throws(() => registry.register(plugin), /already registered/);
    });

    it('should unregister a plugin', () => {
      const plugin = createPlugin('test', 'Test', 'Test', () => identity);
      registry.register(plugin);

      registry.unregister('test');

      assert.strictEqual(registry.has('test'), false);
      assert.strictEqual(registry.size, 0);
    });
  });

  describe('enable/disable', () => {
    it('should enable and disable plugins', () => {
      const plugin = createPlugin('test', 'Test', 'Test', () => identity, {
        defaultEnabled: false,
      });
      registry.register(plugin);

      assert.strictEqual(registry.isEnabled('test'), false);

      registry.setEnabled('test', true);
      assert.strictEqual(registry.isEnabled('test'), true);

      registry.setEnabled('test', false);
      assert.strictEqual(registry.isEnabled('test'), false);
    });

    it('should throw when enabling non-existent plugin', () => {
      assert.throws(() => registry.setEnabled('nonexistent', true), /not found/);
    });
  });

  describe('getEnabled', () => {
    beforeEach(() => {
      registry.register(createPlugin('a', 'A', 'A', () => identity, {
        defaultEnabled: true,
        priority: 10,
        tags: ['core'],
      }));
      registry.register(createPlugin('b', 'B', 'B', () => identity, {
        defaultEnabled: false,
        priority: 20,
        tags: ['extra'],
      }));
      registry.register(createPlugin('c', 'C', 'C', () => identity, {
        defaultEnabled: true,
        priority: 30,
        tags: ['core', 'extra'],
      }));
    });

    it('should return enabled plugins sorted by priority', () => {
      const enabled = registry.getEnabled();

      assert.deepStrictEqual(enabled.map(p => p.id), ['a', 'c']);
    });

    it('should filter by tags', () => {
      const enabled = registry.getEnabled({ tags: ['extra'] });

      // Only enabled plugins with 'extra' tag
      assert.deepStrictEqual(enabled.map(p => p.id), ['c']);
    });

    it('should exclude by tags', () => {
      const enabled = registry.getEnabled({ excludeTags: ['extra'] });

      assert.deepStrictEqual(enabled.map(p => p.id), ['a']);
    });

    it('should handle quick preset', () => {
      const enabled = registry.getEnabled({ preset: 'quick' });

      // Quick preset only includes 'core' tagged plugins
      assert.deepStrictEqual(enabled.map(p => p.id), ['a', 'c']);
    });

    it('should handle full preset', () => {
      const enabled = registry.getEnabled({ preset: 'full' });

      // Full preset enables all
      assert.deepStrictEqual(enabled.map(p => p.id), ['a', 'b', 'c']);
    });
  });

  describe('createPipeline', () => {
    it('should create a pipeline from enabled plugins', () => {
      registry.register(createPlugin('test', 'Test', 'Test', () => identity, {
        tags: ['core'],  // Add 'core' tag so it's included in 'quick' preset
      }));

      const pipeline = registry.createPipeline();

      assert.ok(pipeline);
      assert.ok(pipeline.getSteps().length > 0);
    });

    it('should respect enable/disable overrides', () => {
      registry.register(createPlugin('a', 'A', 'A', () => identity, {
        defaultEnabled: true,
        priority: 10,
      }));
      registry.register(createPlugin('b', 'B', 'B', () => identity, {
        defaultEnabled: false,
        priority: 20,
      }));

      const pipeline = registry.createPipeline({
        enablePlugins: ['b'],
        disablePlugins: ['a'],
      });

      const steps = pipeline.getSteps();
      assert.deepStrictEqual(steps.map(s => s.name), ['b']);
    });
  });

  describe('getVersionHash', () => {
    it('should generate consistent hash', () => {
      registry.register(createPlugin('a', 'A', 'A', () => identity, { version: '1.0.0' }));
      registry.register(createPlugin('b', 'B', 'B', () => identity, { version: '2.0.0' }));

      const hash1 = registry.getVersionHash();
      const hash2 = registry.getVersionHash();

      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash1.length, 12);
    });

    it('should change when version changes', () => {
      const v1 = createPlugin('a', 'A', 'A', () => identity, { version: '1.0.0' });
      registry.register(v1);
      const hash1 = registry.getVersionHash();

      registry.unregister('a');
      const v2 = createPlugin('a', 'A', 'A', () => identity, { version: '1.0.1' });
      registry.register(v2);
      const hash2 = registry.getVersionHash();

      assert.notStrictEqual(hash1, hash2);
    });
  });

  describe('events', () => {
    it('should emit events on register/unregister', () => {
      const events: string[] = [];
      registry.addListener((event) => {
        events.push(`${event.type}:${event.pluginId}`);
      });

      const plugin = createPlugin('test', 'Test', 'Test', () => identity);
      registry.register(plugin);
      registry.unregister('test');

      assert.deepStrictEqual(events, ['register:test', 'unregister:test']);
    });

    it('should emit events on enable/disable', () => {
      const events: string[] = [];
      const plugin = createPlugin('test', 'Test', 'Test', () => identity, {
        defaultEnabled: false,
      });
      registry.register(plugin);

      registry.addListener((event) => {
        events.push(`${event.type}:${event.pluginId}`);
      });

      registry.setEnabled('test', true);
      registry.setEnabled('test', false);

      assert.deepStrictEqual(events, ['enable:test', 'disable:test']);
    });
  });
});

describe('createPlugin', () => {
  it('should create a plugin with defaults', () => {
    const plugin = createPlugin('test', 'Test', 'Description', () => identity);

    assert.strictEqual(plugin.id, 'test');
    assert.strictEqual(plugin.name, 'Test');
    assert.strictEqual(plugin.description, 'Description');
    assert.strictEqual(plugin.version, '1.0.0');
    assert.strictEqual(plugin.defaultEnabled, true);
    assert.strictEqual(plugin.priority, 100);
  });

  it('should allow custom options', () => {
    const plugin = createPlugin('test', 'Test', 'Description', () => identity, {
      version: '2.0.0',
      defaultEnabled: false,
      priority: 50,
      tags: ['custom'],
    });

    assert.strictEqual(plugin.version, '2.0.0');
    assert.strictEqual(plugin.defaultEnabled, false);
    assert.strictEqual(plugin.priority, 50);
    assert.deepStrictEqual(plugin.tags, ['custom']);
  });
});

describe('registerPlugins', () => {
  it('should register multiple plugins', () => {
    const registry = new PluginRegistry();
    const plugins = [
      createPlugin('a', 'A', 'A', () => identity),
      createPlugin('b', 'B', 'B', () => identity),
    ];

    registerPlugins(registry, plugins);

    assert.strictEqual(registry.size, 2);
    assert.strictEqual(registry.has('a'), true);
    assert.strictEqual(registry.has('b'), true);
  });
});
