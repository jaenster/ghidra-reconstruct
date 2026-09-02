/**
 * A label on the interior of a typed object inherits that object's TYPE, and
 * therefore its size. Emitting storage for it creates two globals that alias one
 * datum in the original image and stop aliasing the moment they are relinked.
 *
 * The case that motivated this: `gGameStateData4` sits 4 bytes inside
 * `globalOpenFileHandleArray` (FILE*[20], 80 bytes) and reports 80 bytes of its
 * own. The tree emitted both, so Fog's log manager stored handles through one and
 * read them through the other, then handed fclose() a junk pointer and faulted
 * inside the CRT on a background thread while the main thread was loading a
 * palette. 15663 symbols in the program have this shape.
 *
 * The rule is deliberately narrow. "Contained" alone is NOT enough: a contained
 * symbol carrying its OWN smaller size may be a real field, and dropping those
 * once cost four symbols their definitions and produced an extern with no
 * definition anywhere. Only the inherited size proves the label did not measure
 * itself.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  setInteriorLabelSymbols, resetInteriorLabelSymbols, isInteriorLabel,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol } from '../types.js';

const sym = (name: string, address: string, size: number): AnalyzedDataSymbol =>
  ({ name, address, size, dataType: 'undefined', isInitialized: false,
     xrefCount: 1, scope: 'global' } as AnalyzedDataSymbol);

describe('an interior label that inherited its container size emits no storage', () => {
  beforeEach(() => resetInteriorLabelSymbols());

  /** Real 1.14d layout: the log manager's handle array and its interior label. */
  const CONTAINER = sym('globalOpenFileHandleArray', '0075e790', 80);
  const INHERITED = sym('gGameStateData4', '0075e794', 80);

  it('marks a same-size symbol sitting inside another as interior', () => {
    setInteriorLabelSymbols([CONTAINER, INHERITED]);
    assert.strictEqual(isInteriorLabel('gGameStateData4'), true);
  });

  it('leaves the container itself alone', () => {
    setInteriorLabelSymbols([CONTAINER, INHERITED]);
    assert.strictEqual(isInteriorLabel('globalOpenFileHandleArray'), false);
  });

  // The narrowness IS the safety argument: a contained symbol with its own,
  // smaller size may be a genuine field that someone typed deliberately.
  it('does NOT touch a contained symbol carrying its own smaller size', () => {
    setInteriorLabelSymbols([CONTAINER, sym('nRealField', '0075e794', 4)]);
    assert.strictEqual(isInteriorLabel('nRealField'), false);
  });

  it('does NOT touch a same-size symbol that is merely adjacent, not inside', () => {
    setInteriorLabelSymbols([CONTAINER, sym('gNeighbour', '0075e7e0', 80)]);
    assert.strictEqual(isInteriorLabel('gNeighbour'), false);
  });

  // Two small symbols a byte apart satisfy "strictly contains, same size" purely by
  // misalignment. gpfnMouseLeftButtonAltHandler lost its declaration that way, and
  // its supposed container was itself only 4 bytes - no container is 4 bytes.
  it('ignores a sub-8-byte "container", which is misalignment not containment', () => {
    setInteriorLabelSymbols([
      sym('gpfnMouseLeftButtonHandler', '007a6b10', 4),
      sym('gSomethingAt09', '007a6b09', 4),
      sym('gpfnMouseLeftButtonAltHandler', '007a6b0c', 4),
    ]);
    assert.strictEqual(isInteriorLabel('gpfnMouseLeftButtonAltHandler'), false);
  });

  it('does not fire when no model has been registered', () => {
    assert.strictEqual(isInteriorLabel('gGameStateData4'), false);
  });
});
