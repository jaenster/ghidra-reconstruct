/**
 * warnings.tsv: Ghidra WARNING comments as rows, independent of input order.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatWarningsTsv, warningRows, WARNINGS_TSV } from '../codegen/warning-facts.js';
import { writeProject } from '../codegen/index.js';
import type { ExtractedFunction, ReconstructedProject } from '../types.js';

function fn(address: string, name: string, namespace: string | undefined, decompiled: string): ExtractedFunction {
  return {
    name, address, namespace, decompiled, signature: '', returnType: 'void', parameters: [],
    localVariables: [], callingConvention: '__cdecl', size: 0, isThunk: false,
  } as unknown as ExtractedFunction;
}

const FUNCS = [
  fn('0053afb0', 'EnsureDrlgActLoaded', 'D2Game::GAME::Level', `
/* WARNING: Unknown calling convention */

void EnsureDrlgActLoaded(int a)

{
  /* WARNING: Subroutine does not return */
  InitDrlgAct(a);
}
`),
  fn('00401000', 'Halt', undefined, `
void Halt(void)

{
                    /* WARNING: Subroutine does not return */
  compiler::_exit(-1);
}
`),
  fn('00402000', 'Plain', 'Ns', `void Plain(void) { return; }`),
];

describe('warningRows', () => {
  it('orders rows by address, keeps text order inside a function, and names the callee', () => {
    const rows = warningRows(FUNCS);
    assert.deepStrictEqual(rows.map(r => [r.address, r.function, r.kind, r.class, r.detail]), [
      ['00401000', 'Halt', 'noreturn', 'informational', 'Subroutine does not return -> _exit'],
      ['0053afb0', 'D2Game::GAME::Level::EnsureDrlgActLoaded', 'unknown-calling-convention', 'informational', 'Unknown calling convention'],
      ['0053afb0', 'D2Game::GAME::Level::EnsureDrlgActLoaded', 'noreturn-unknown-callee', 'defect', 'Subroutine does not return -> InitDrlgAct'],
    ]);
  });

  it('is the same file whatever order the functions arrive in', () => {
    const a = formatWarningsTsv(warningRows(FUNCS));
    const b = formatWarningsTsv(warningRows([...FUNCS].reverse()));
    assert.strictEqual(a, b);
    assert.ok(a.startsWith('address\tfunction\tkind\tclass\tdetail\n'));
  });

  it('writeProject writes warnings.tsv at the output root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'warning-facts-'));
    try {
      const project = {
        name: 'p', files: new Map(), sourceMaps: new Map(), dataTypes: [], globals: [], classes: [],
        namespaces: [], warnings: warningRows(FUNCS),
      } as unknown as ReconstructedProject;
      await writeProject(project, dir, { generateCMake: false } as any);
      const text = await readFile(join(dir, WARNINGS_TSV), 'utf8');
      assert.strictEqual(text, formatWarningsTsv(warningRows(FUNCS)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
