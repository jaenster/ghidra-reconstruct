/** Golden: 1.14d Ghidra output in; a word local the original compares in a whole register comes out 32-bit. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../ghidra.js';

// INPUT_HelpCloseButtonUp 00496720: original `add ebx, -0x18; cmp ebx, 0x20`, ours `cmp bx, 0x20`.
const input = `void INPUT_HelpCloseButtonUp(D2UIMouseMsgStrc *pMsg)
{
  DWORD eResMode;
  uint nRelX;
  ushort nMouseY;

  nMouseY = (pMsg->uLParam).sMousePos.nMouseY;
  nRelX = (uint)(pMsg->uLParam).sMousePos.nMouseX;
  if (gpHelpCloseButton != 0) {
    eResMode = D2GFX_GetResolutionMode();
    if (eResMode == 2) {
      nRelX = nRelX - 0x2ad;
    }
    else {
      nRelX = nRelX - 0x20d;
    }
    if ((nRelX < 0x21) && (nMouseY - 0x18 < 0x21)) {
      HELP_HideMiniPanel();
    }
  }
  return;
}`;
// ord text opcode size cs k fp0 fp1 op user um setter sm w a b bv pair
const sites = [
  '0\t!=\tINT_NOTEQUAL\t4\t1\t0\tv:gpHelpCloseButton\tc:0\t00496723\t00496738\tje\t00496723\tcmp\t4\tm\ti\t0\t1',
  '1\t==\tINT_EQUAL\t4\t1\t2\tv:eResMode\tc:2\t0049673f\t00496742\tjne\t0049673f\tcmp\t4\tr\ti\t2\t1',
  '2\t<\tINT_LESS\t4\t1\t21\tv:nRelX\tc:21\t0049674a\t0049674d\tja\t0049674a\tcmp\t4\tr\ti\t20\t1',
  '3\t<\tINT_LESS\t4\t1\t21\te\tc:21\t00496752\t00496755\tja\t00496752\tcmp\t4\tr\ti\t20\t1',
].join('\n');

const run = (s?: string) => transformGhidraCode(input, {
  preset: 'full', usePluginRegistry: true, tolerateErrors: false,
  pluginOptions: s ? { pluginOptions: { 'narrow-compare-widen': { compareSites: s } as never } } : undefined,
}).code;

describe('Golden: narrow local compared in a whole register', () => {
  it('declares nMouseY 32-bit when the original compares it as a dword', () => {
    const out = run(sites);
    assert.ok(!/\b(ushort|uint16_t)\s+nMouseY\b/.test(out), `still narrow:\n${out}`);
    assert.match(out, /\b(uint|uint32_t)\s+nMouseY\b/, `not widened:\n${out}`);
  });
  it('leaves it alone without the facts', () => {
    assert.match(run(), /\b(ushort|uint16_t)\s+nMouseY\b/);
  });
});
