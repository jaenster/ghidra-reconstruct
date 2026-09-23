/**
 * What every check is handed: the parsed tree, the snapshot, and the questions that need
 * both - "what does this name refer to here?", "how many bytes is this?".
 */

import { NodeKind, type ASTNode } from '@ghidra-mcp/cpp-parser';
import {
  constValue, refName, strip, typeWidth, walk, isArrayType, elementType, unqualified,
  type SizeEnv, type ScopeEntry,
} from './ast.js';
import { fileScopeVars, type FunctionInfo, type GlobalDecl, type SourceFile, type Tree } from './tree.js';
import type { Snapshot } from './snapshot.js';

export interface Finding {
  check: string;
  /** Tree-relative file, when the finding is a site rather than a symbol. */
  file?: string;
  line?: number;
  /** Qualified function name, when the site is inside one. */
  fn?: string;
  /** What the finding is about: a variable, a global, a struct. */
  subject: string;
  detail: string;
  /** Location-free identity of the offending node - see ast.signature. */
  sig?: string;
}

export interface Check {
  id: string;
  blurb: string;
  run(ctx: LintContext): Finding[];
}

export type Resolved =
  | { kind: 'local' | 'param'; entry: ScopeEntry; type: any }
  | { kind: 'file'; decl: any; type: any }
  | { kind: 'global'; decl: GlobalDecl; type: any };

/** Every node of a function, bucketed by kind, collected in one walk. */
export interface FnNodes {
  all: ASTNode[];
  byKind: Map<string, any[]>;
}

export class LintContext {
  readonly sizeEnv: SizeEnv;
  private fnNodes = new Map<FunctionInfo, FnNodes>();
  private fileVars = new Map<SourceFile, Map<string, any>>();

  constructor(readonly tree: Tree, readonly snapshot: Snapshot | null) {
    this.sizeEnv = {
      named: (name: string) => snapshot?.typeSize.get(name) ?? null,
    };
  }

  nodes(fn: FunctionInfo): FnNodes {
    let n = this.fnNodes.get(fn);
    if (!n) {
      const all: ASTNode[] = [];
      const byKind = new Map<string, any[]>();
      walk((fn.node as any).body, (x) => {
        all.push(x);
        let b = byKind.get(x.kind);
        if (!b) byKind.set(x.kind, (b = []));
        b.push(x);
      });
      n = { all, byKind };
      this.fnNodes.set(fn, n);
    }
    return n;
  }

  of(fn: FunctionInfo, kind: NodeKind): any[] {
    return this.nodes(fn).byKind.get(kind) ?? [];
  }

  fileScope(file: SourceFile): Map<string, any> {
    let m = this.fileVars.get(file);
    if (!m) this.fileVars.set(file, (m = fileScopeVars(file)));
    return m;
  }

  /**
   * What a plain name means inside `fn`: a local or parameter shadows a file-scope variable,
   * which shadows the tree's globals. `::x` skips the function scope.
   */
  resolve(fn: FunctionInfo | null, expr: any, file?: SourceFile): Resolved | null {
    const name = refName(expr);
    if (!name) return null;
    const isGlobalQualified = expr?.kind === NodeKind.QualifiedId;
    if (fn && !isGlobalQualified) {
      const e = fn.scope().get(name);
      if (e) return { kind: e.kind, entry: e, type: e.type };
    }
    const f = fn?.file ?? file;
    if (f) {
      const d = this.fileScope(f).get(name);
      if (d && !(d.specifiers ?? []).includes('extern')) return { kind: 'file', decl: d, type: d.type };
    }
    const g = this.tree.globals.get(name);
    if (g) return { kind: 'global', decl: g, type: g.type };
    return null;
  }

  /** sizeof(operand) where the operand is a type or a resolvable expression. */
  sizeofIn(fn: FunctionInfo | null) {
    return (operand: any, isType: boolean): number | null => {
      if (isType) {
        // `sizeof(x)` parses as a type when x is a bare name; a variable wins if one exists.
        const t = unqualified(operand);
        if (t?.kind === NodeKind.TypedefType && t.name?.kind === NodeKind.Identifier) {
          const r = this.resolve(fn, t.name);
          if (r) return typeWidth(r.type, this.sizeEnv);
        }
        return typeWidth(operand, this.sizeEnv);
      }
      const t = this.exprType(fn, operand);
      return t ? typeWidth(t, this.sizeEnv) : null;
    };
  }

  value(fn: FunctionInfo | null, e: any): number | null {
    return constValue(e, this.sizeofIn(fn));
  }

  /** The declared type of a simple lvalue: a name, `a[i]` of a known array, `*p`. */
  exprType(fn: FunctionInfo | null, e: any): any {
    const s = e?.kind === NodeKind.ParenExpr ? strip(e) : e;
    if (!s) return null;
    const r = this.resolve(fn, s);
    if (r) return r.type;
    if (s.kind === NodeKind.SubscriptExpr) {
      const bt = this.exprType(fn, s.array);
      return bt ? elementType(bt) : null;
    }
    if (s.kind === NodeKind.UnaryExpr && s.operator === '*') {
      const bt = this.exprType(fn, s.operand);
      return bt ? elementType(bt) : null;
    }
    if (s.kind === NodeKind.CStyleCastExpr) return s.type;
    return null;
  }

  isArray(fn: FunctionInfo | null, e: any): boolean {
    return isArrayType(this.exprType(fn, e));
  }
}
