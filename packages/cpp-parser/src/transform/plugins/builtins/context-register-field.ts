/**
 * Context Register Field Plugin
 *
 * Fog's crash handler and stack walker read the thread's registers out of a
 * Win32 `CONTEXT`: `ctx.Eip`, `pContext->Esp`, `ctx.FloatSave.RegisterArea`.
 * Those members exist only in the x86 `CONTEXT`; the x64 one names the same
 * registers `Rip`/`Rsp`/... and keeps the x87 state in `FltSave`, so a source
 * that spells them builds for one target only.
 *
 * Each such member access is written through an accessor macro of the platform
 * header (CONTEXT_FIELD_SUPPORT_LINES):
 *
 *   ctx.Eip                      ->  D2_CONTEXT_FIELD(ctx, Eip)
 *   pContext->Esp                ->  D2_CONTEXT_FIELD(*pContext, Esp)
 *   ctx.FloatSave.ControlWord    ->  D2_CONTEXT_FIELD(ctx, FloatSave).ControlWord
 *   ctx.FloatSave.RegisterArea   ->  D2_CONTEXT_X87_AREA(ctx)
 *
 * On x86 the macros expand to `((ctx).Eip)` and `((ctx).FloatSave.RegisterArea)`:
 * the very member access, so the value, the type and the lvalue are unchanged
 * and the compiler sees the same expression. On x64 they name the register of
 * the same role. The x87 register area is laid out differently there (16-byte
 * slots, not 10), so x64 gets an address of the same type, not the same bytes:
 * the accessor exists so the source builds, the 32-bit target is what it is
 * faithful to.
 *
 * Only a member whose object is known to be a `CONTEXT` is touched; a field of
 * another struct that happens to be called `Eip` stays as it is.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, MemberExpr, TypeNode,
  StructDecl, FieldDecl, Identifier, CallExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import type { TypedefResolver } from './call-arg-cast.js';

export const CONTEXT_FIELD_HELPER = 'D2_CONTEXT_FIELD';
export const CONTEXT_X87_AREA_HELPER = 'D2_CONTEXT_X87_AREA';

/** The x86-only members of `CONTEXT` and the x64 member of the same role. */
export const X86_CONTEXT_FIELDS: Readonly<Record<string, string>> = {
  Eax: 'Rax', Ebx: 'Rbx', Ecx: 'Rcx', Edx: 'Rdx', Esi: 'Rsi', Edi: 'Rdi',
  Ebp: 'Rbp', Esp: 'Rsp', Eip: 'Rip', FloatSave: 'FltSave',
};

/** The accessors' text; the platform header includes it verbatim. C++03, so VC8 compiles it too. */
export const CONTEXT_FIELD_SUPPORT_LINES: readonly string[] = [
  '// The x86-only registers of a Win32 CONTEXT, by the role they have on either target',
  '// (see context-register-field.ts). On x86 each is the member access itself.',
  '#if defined(_WIN64) || defined(__x86_64__)',
  ...Object.entries(X86_CONTEXT_FIELDS).map(([x86, x64]) => `#define D2_CONTEXT_X64_${x86} ${x64}`),
  `#define ${CONTEXT_FIELD_HELPER}(c, f) ((c).D2_CONTEXT_X64_##f)`,
  `#define ${CONTEXT_X87_AREA_HELPER}(c) ((BYTE*)(c).FltSave.FloatRegisters)`,
  '#else',
  `#define ${CONTEXT_FIELD_HELPER}(c, f) ((c).f)`,
  `#define ${CONTEXT_X87_AREA_HELPER}(c) ((c).FloatSave.RegisterArea)`,
  '#endif',
];

export interface ContextRegisterFieldOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const CONTEXT_TYPES = new Set(['CONTEXT', '_CONTEXT']);
const CONTEXT_POINTER_TYPES = new Set(['PCONTEXT', 'LPCONTEXT']);

let siteCount = 0;
export function getContextRegisterFieldCount(): number { return siteCount; }
export function resetContextRegisterFieldCount(): void { siteCount = 0; }

export function createContextRegisterFieldTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ContextRegisterFieldOptions;
  const typedefTargets = o.typedefTargets ?? {};
  // CONTEXT is resolved here by its own names, never through a typedef chain that
  // could end at an unrelated struct.
  const resolve: TypedefResolver = name =>
    CONTEXT_TYPES.has(name) || CONTEXT_POINTER_TYPES.has(name) ? undefined : typedefTargets[name];

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const members = findNodesByKind(node.body, NodeKind.MemberExpr) as MemberExpr[];
      if (!members.some(m => memberName(m) !== undefined && memberName(m)! in X86_CONTEXT_FIELDS)) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      // A frame group is a struct declared in the body (`__frame1_t`); its members
      // are typed there and nowhere else.
      const structFields: Record<string, Record<string, string>> = { ...(o.structFields ?? {}) };
      for (const s of findNodesByKind(node.body, NodeKind.StructDecl) as StructDecl[]) {
        const name = s.name && s.name.kind === NodeKind.Identifier ? (s.name as Identifier).name : undefined;
        if (!name || structFields[name]) continue;
        const fields: Record<string, string> = {};
        for (const m of s.members) {
          const mk = (m as ASTNode).kind;
          if (mk === NodeKind.FieldDecl || mk === NodeKind.VariableDecl) {
            const f = m as unknown as FieldDecl | VariableDecl;
            fields[f.name.name] = emit(f.type as never);
          }
        }
        structFields[name] = fields;
      }
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields,
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      /** The object a member access reads a CONTEXT through, as an object expression, or null. */
      const contextObject = (m: MemberExpr): Expression | null => {
        const s = shapeOf(m.object);
        if (!s) return null;
        const base = s.base.replace(/^::/, '').replace(/^struct\s+/, '');
        const stars = s.stars + (CONTEXT_POINTER_TYPES.has(base) ? 1 : 0);
        if (!CONTEXT_TYPES.has(base) && !CONTEXT_POINTER_TYPES.has(base)) return null;
        if (stars !== (m.isArrow ? 1 : 0)) return null;
        return m.isArrow ? Expr.deref(m.object) : m.object;
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.MemberExpr) return undefined;
          const m = n as MemberExpr;
          // ctx.FloatSave.RegisterArea: the x87 area as a whole. Members are visited
          // inner first, so FloatSave already reads `D2_CONTEXT_FIELD(ctx, FloatSave)`.
          if (memberName(m) === 'RegisterArea' && !m.isArrow) {
            const obj = floatSaveObject(m.object);
            if (obj) return Expr.call(CONTEXT_X87_AREA_HELPER, [obj]);
          }
          const name = memberName(m);
          if (name === undefined || !(name in X86_CONTEXT_FIELDS)) return undefined;
          const obj = contextObject(m);
          if (!obj) return undefined;
          changed = true;
          siteCount++;
          return Expr.call(CONTEXT_FIELD_HELPER, [obj, Expr.identifier(name)]);
        },
      });
      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

/** The CONTEXT object of an accessor call `D2_CONTEXT_FIELD(obj, FloatSave)`, or null. */
function floatSaveObject(e: Expression): Expression | null {
  if (e.kind !== NodeKind.CallExpr) return null;
  const c = e as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier || (c.callee as Identifier).name !== CONTEXT_FIELD_HELPER) return null;
  const f = c.arguments[1];
  return c.arguments.length === 2 && f.kind === NodeKind.Identifier && (f as Identifier).name === 'FloatSave'
    ? c.arguments[0] as Expression
    : null;
}

function memberName(m: MemberExpr): string | undefined {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : undefined;
}

export const contextRegisterFieldPlugin: TransformPlugin = {
  id: 'context-register-field',
  name: 'Context Register Field',
  description:
    'Reads the x86-only registers of a Win32 CONTEXT through platform-header accessors that are the member access itself on x86',
  version: '1.0.0',
  // Last, beside pointer-word-cast: it only respells, and no pass after it reads a CONTEXT member.
  priority: 996,
  afterSourceForms: true,
  defaultEnabled: true,
  tags: ['cleanup', 'portability'],
  createTransformer: createContextRegisterFieldTransformer,
};
