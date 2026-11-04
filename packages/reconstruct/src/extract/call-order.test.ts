import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callOrderScript, CALL_PUSHES_JAVA } from './call-order.js';
import { functionFactsScript } from './function-facts.js';

/** The walk back from a CALL in a script: from its loop to the PUSH count. */
function walk(script: string): string {
  const i = script.indexOf('for (int guard = 0; guard < 200; guard++)');
  assert.ok(i >= 0, 'no walk');
  return script.slice(i, script.indexOf('cur = p;', i));
}

describe('call-order push count', () => {
  for (const [name, script] of [['call-order', callOrderScript(['00401000'])], ['function-facts', functionFactsScript(['00401000'])]] as const) {
    // CLIENT_SpawnTowerMistEffect, 0046b710: `push ebp; mov ebp, esp; sub esp, 0x5c; push ebx;
    // push esi; push edi; push 0x173; mov edi, ecx; push 2; ...; call UNITS_GetRoom`. The
    // three saves were counted as argument pushes (7 where the nested form has 4).
    it(`${name}: counts a PUSH only when it sets up an argument`, () => {
      const w = walk(script);
      assert.match(w, /if \(p\.getMnemonicString\(\)\.equalsIgnoreCase\("PUSH"\) && !notArgPush\.test\(fn, p\)\) pushes\+\+;/);
      assert.ok(script.includes(CALL_PUSHES_JAVA.trim().split('\n')[0].trim()), 'notArgPush is declared');
    });

    // An SEH frame is linked by `mov fs:[0], esp` after `push -1; push handler; push eax`.
    it(`${name}: stops at the store that links an SEH frame`, () => {
      const w = walk(script);
      const seh = w.indexOf('"FS:"');
      const push = w.indexOf('pushes++');
      assert.ok(seh >= 0 && seh < push, w);
    });
  }

  // The scripts run as the body of a GhidraScript; a compile error there blocks the daemon.
  // Compiled against the worker's classpath when the local worker has been built.
  const here = dirname(fileURLToPath(import.meta.url));
  const cpFile = join(here, '../../../local-worker/dist/classpath.txt');
  const javac = spawnSync('javac', ['-version']).status === 0;
  it('compiles as a Ghidra script', { skip: !existsSync(cpFile) || !javac ? 'no local worker build or javac' : false }, () => {
    const cp = readFileSync(cpFile, 'utf8').trim();
    for (const [cls, script] of [['CallOrderCheck', callOrderScript(['00401000'])], ['FunctionFactsCheck', functionFactsScript(['00401000'])]]) {
      const dir = mkdtempSync(join(tmpdir(), 'call-order-'));
      try {
        writeFileSync(join(dir, `${cls}.java`), [
          'import ghidra.app.script.GhidraScript;',
          'import ghidra.program.model.address.*;',
          'import ghidra.program.model.data.*;',
          'import ghidra.program.model.listing.*;',
          'import ghidra.program.model.mem.*;',
          'import ghidra.program.model.pcode.*;',
          'import ghidra.program.model.symbol.*;',
          'import ghidra.program.model.scalar.*;',
          'import ghidra.util.task.TaskMonitor;',
          'import java.util.*;',
          `public class ${cls} extends GhidraScript {`,
          '  @Override',
          '  protected void run() throws Exception {',
          script,
          '  }',
          '}',
        ].join('\n'));
        const r = spawnSync('javac', ['-nowarn', '-classpath', cp, '-d', dir, join(dir, `${cls}.java`)], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `${cls}: ${r.stderr}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
