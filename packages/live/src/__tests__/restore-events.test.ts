import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, isModelInvalidatingRestore, type ChangeEvent, type LiveModel, type ModelIndices } from '../model.js';

/**
 * applyEvents decides, before touching anything, whether the model can still be
 * trusted. These cover that decision only, so the model can be a stub: every
 * path under test returns before the extraction work begins.
 */
function stubModel(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: { functions: [], globals: [], types: [] },
  } as unknown as LiveModel;
}
const indices = {} as ModelIndices;
const client = {} as never;

function restore(seq: number, txDescription?: string, txId?: number): ChangeEvent {
  return { seq, kind: 'restored', target: 'program', key: '*', txDescription, txId } as ChangeEvent;
}

function fnChanged(seq: number, txId: number): ChangeEvent {
  return { seq, kind: 'function.changed', target: 'function', key: '00412080', txId } as ChangeEvent;
}

test('a check-in\'s metadata event does not invalidate the model', async () => {
  const model = stubModel();
  const result = await applyEvents(model, indices, [restore(18, 'Update Metadata')], client);
  assert.equal(result.needsFullResync, false);
  assert.equal(model.seq, 18, 'the event is still consumed, not replayed forever');
});

test('a real restore invalidates the model', async () => {
  const model = stubModel();
  const result = await applyEvents(model, indices, [restore(18, 'Undo')], client);
  assert.equal(result.needsFullResync, true);
});

test('a restore with no transaction name is treated as real', async () => {
  const model = stubModel();
  const result = await applyEvents(model, indices, [restore(18)], client);
  assert.equal(result.needsFullResync, true);
});

test('a real restore still wins when batched with check-in bookkeeping', async () => {
  const model = stubModel();
  const result = await applyEvents(
    model, indices, [restore(17, 'Update Metadata'), restore(18, 'Undo')], client,
  );
  assert.equal(result.needsFullResync, true);
});

test('a restore explained by its own transaction is not a rollback', () => {
  // Giving a function custom parameter storage re-syncs the program, so Ghidra
  // fires a restore alongside the targeted events for that same transaction.
  // Those events describe the change completely, so the model can follow them.
  const batch = [fnChanged(35, 35), restore(37, 'Set custom signature', 35)];
  assert.equal(isModelInvalidatingRestore(batch[1]!, batch), false);
});

test('a restore whose transaction produced only program-level events is a rollback', () => {
  const batch = [restore(37, 'Undo', 35), restore(38, 'Undo', 35)];
  assert.equal(isModelInvalidatingRestore(batch[0]!, batch), true);
});

test('a bare restore with a txId nothing else shares is still a rollback', async () => {
  const model = stubModel();
  const result = await applyEvents(model, indices, [restore(37, 'Undo', 99)], client);
  assert.equal(result.needsFullResync, true);
});
