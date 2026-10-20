/**
 * Import Address Forwarder Plugin
 *
 * The binary takes the ADDRESS of a kernel32 import and calls through it:
 *
 *   pfnInterlocked = InterlockedCompareExchange;      // BNCLIENT_... , 6 sites in BnSend.cpp
 *
 * In MSVC that is the `__stdcall` export in the IAT. mingw's <winbase.h> maps the name to
 * the GCC intrinsic `_InterlockedCompareExchange`, which is not a `__stdcall` function and
 * has no address of that type ("no matches converting function to type
 * fnInterlockedCompareExchange"). The platform header defines a `__stdcall` forwarder with
 * the import's prototype; a reference to the import that is not a call - its address being
 * taken - is spelled as the forwarder. Direct calls keep the intrinsic.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CallExpr, Identifier } from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

/** Import name -> the platform header's `__stdcall` forwarder with the import's own prototype. */
export const IMPORT_ADDRESS_FORWARDERS: Readonly<Record<string, string>> = {
  InterlockedCompareExchange: 'd2_InterlockedCompareExchange',
};

const FORWARDED = new Map(Object.entries(IMPORT_ADDRESS_FORWARDERS).map(([imp, fwd]) => [fwd, imp]));

function createImportAddressForwarderTransformer(): Transformer {
  // Bottom-up: every use is respelled at the identifier, then a parent for which the name
  // is NOT an address - the callee of a call, a member name - puts the import's name back.
  const restore = (e: ASTNode): ASTNode | null => {
    let x = e;
    while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: ASTNode }).expression;
    if (x.kind !== NodeKind.Identifier) return null;
    const imp = FORWARDED.get((x as Identifier).name);
    return imp ? ({ ...(x as Identifier), name: imp } as ASTNode) : null;
  };
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.CallExpr) {
        const r = restore((node as CallExpr).callee as ASTNode);
        return r ? ({ ...node, callee: r } as ASTNode) : undefined;
      }
      if (node.kind === NodeKind.MemberExpr) {
        const m = node as unknown as { member: ASTNode };
        const r = restore(m.member);
        return r ? ({ ...node, member: r } as ASTNode) : undefined;
      }
      if (node.kind !== NodeKind.Identifier) return undefined;
      const fwd = IMPORT_ADDRESS_FORWARDERS[(node as Identifier).name];
      return fwd ? ({ ...(node as Identifier), name: fwd } as ASTNode) : undefined;
    },
  });
}

export const importAddressForwarderPlugin: TransformPlugin = createPlugin(
  'import-address-forwarder',
  'Import Address Forwarder',
  "A Win32 import whose address is taken, where the toolchain declares an intrinsic, is spelled as a __stdcall forwarder",
  () => createImportAddressForwarderTransformer(),
  { priority: 31, defaultEnabled: true, tags: ['platform'], version: '1.0.0' },
);
