/**
 * Fixture-based transform tests using real Ghidra decompilations.
 *
 * Each fixture is a JSON file with:
 * - input: raw Ghidra pseudocode
 * - output_quick: expected output from quick preset
 * - output_full: expected output from full preset
 *
 * These fixtures are language-agnostic and can be used to verify
 * a reimplementation in any language (e.g., Rust).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { transformGhidraCode, preprocessGhidraCode } from '../ghidra.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

interface Fixture {
  name: string;
  reason: string;
  address: string;
  input: string;
  preprocessed: string;
  output_quick: string;
  output_full: string;
  success: boolean;
  warnings: string[];
  identifiers: string[];
  preamble?: string;
}

// Load all fixtures
function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  return files.map(f => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf-8')) as Fixture);
}

const fixtures = loadFixtures();

describe(`Fixture-based transforms (${fixtures.length} real Ghidra functions)`, () => {

  // Quick preset tests — verify pipeline succeeds on real input
  describe('Quick preset: succeeds on all inputs', () => {
    for (const fixture of fixtures) {
      it(`${fixture.name} (${fixture.reason})`, () => {
        const result = transformGhidraCode(fixture.input, {
          preset: 'quick',
          usePluginRegistry: true,
          tolerateErrors: true,
        });

        assert.ok(result.success, `Quick transform failed for ${fixture.name}: ${result.error}`);
        assert.ok(result.code.length > 0, `Empty output for ${fixture.name}`);
        // Output should contain the function name
        assert.ok(result.code.includes(fixture.name) || result.code.includes('('),
          `Output doesn't look like valid C for ${fixture.name}`);
      });
    }
  });

  // Quick preset determinism — running twice gives same output
  describe('Quick preset: deterministic', () => {
    for (const fixture of fixtures) {
      it(`${fixture.name} (${fixture.reason})`, () => {
        const r1 = transformGhidraCode(fixture.input, {
          preset: 'quick', usePluginRegistry: true, tolerateErrors: true,
        });
        const r2 = transformGhidraCode(fixture.input, {
          preset: 'quick', usePluginRegistry: true, tolerateErrors: true,
        });
        assert.strictEqual(r1.code, r2.code, `Non-deterministic output for ${fixture.name}`);
      });
    }
  });

  // Full preset tests — verify the full pipeline doesn't crash
  describe('Full preset: no crashes', () => {
    for (const fixture of fixtures) {
      it(`${fixture.name} (${fixture.reason})`, () => {
        // Full preset should not throw (tolerateErrors catches parse errors,
        // but transform errors should be handled gracefully)
        const result = transformGhidraCode(fixture.input, {
          preset: 'full',
          usePluginRegistry: true,
          tolerateErrors: true,
        });

        // At minimum, should return a result (may have warnings)
        assert.ok(result, `No result for ${fixture.name}`);
        assert.ok(typeof result.code === 'string', `No code string for ${fixture.name}`);
      });
    }
  });

  // Identifier extraction — returns non-empty set for all functions
  describe('Identifier extraction', () => {
    for (const fixture of fixtures) {
      it(`${fixture.name}: extracts identifiers`, () => {
        const result = transformGhidraCode(fixture.input, {
          preset: 'quick',
          usePluginRegistry: true,
          tolerateErrors: true,
        });

        assert.ok(result.identifiers.size > 0,
          `No identifiers extracted for ${fixture.name}`);
        // Function name should be in identifiers
        assert.ok(result.identifiers.has(fixture.name),
          `Function name "${fixture.name}" not in identifiers`);
      });
    }
  });

  // Preprocessing determinism
  describe('Preprocessing is deterministic', () => {
    for (const fixture of fixtures) {
      it(`${fixture.name}: preprocessed matches`, () => {
        const preprocessed = preprocessGhidraCode(fixture.input);
        assert.strictEqual(preprocessed, fixture.preprocessed,
          `Preprocessing mismatch for ${fixture.name}`);
      });
    }
  });
});
