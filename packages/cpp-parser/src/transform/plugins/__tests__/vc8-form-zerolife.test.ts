import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import type {AnyNode, TranslationUnit, FunctionDecl, ExprStmt, LambdaExpr} from '../../../ast/nodes.js';
import {NodeKind} from '../../../ast/kinds.js';
import {applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables} from '../builtins/vc8-form.js';
import {compileAndRun, hasNativeGpp} from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const input = `void f(int value) {
  int32_t flag = Check(value);
  if (flag) return;
  if (Bonus()) flag = 1;
  Use(flag);
}`;
const tables: Vc8FormTables = {functionReturnTypes: {Check: 'int32_t'}};
function run(source = input, context = tables) {
  const sites: Vc8FormSite[] = [];
  const form = parseVc8Form('zerolife(flag)')!;
  const ast = applyVc8Forms(parse(source) as TranslationUnit, [{form}], s => sites.push(s), context);
  return {code: emit(ast as AnyNode), site: sites[0]};
}
function refused(source: string, context = tables) {
  const {code, site} = run(source, context);
  assert.equal(site.applied, false, source);
  assert.equal(flat(code), flat(emit(parse(source) as AnyNode)), 'refusal is atomic');
}

describe('vc8-form: zerolife', () => {
  it('parses one local identifier only', () => {
    assert.deepEqual(parseVc8Form('zerolife(flag)'), {op: 'zerolife', name: 'flag'});
    for (const bad of ['', 'flag,other', 'flag + 1', 'flag,@1', 'int']) assert.equal(parseVc8Form(`zerolife(${bad})`), undefined);
  });
  it('starts the later lifetime at zero after evaluating the call exactly once', () => {
    const {code, site} = run();
    assert.equal(site.applied, true, site.why);
    assert.match(flat(code), /if \(Check\(value\)\) return; int32_t flag = 0;/);
    assert.equal((code.match(/Check\(/g) ?? []).length, 1);
  });
  it('accepts a brace-wrapped bare return and an unsigned word', () => {
    const {site} = run(input.replace('int32_t flag', 'uint32_t flag').replace('if (flag) return;', 'if (flag) { return; }'), {functionReturnTypes: {Check: 'uint32_t'}});
    assert.equal(site.applied, true, site.why);
  });
  for (const type of ['volatile int32_t', 'const int32_t', 'int16_t', 'bool', 'float', 'Unknown', 'int32_t*']) {
    it(`refuses the local type ${type}`, () => refused(input.replace('int32_t flag', `${type} flag`)));
  }
  for (const result of ['int16_t', 'float', 'uint64_t', 'Unknown', 'int32_t*']) {
    it(`refuses the initializer result ${result}`, () => refused(input, {functionReturnTypes: {Check: result}}));
  }
  it('requires the callee return contract', () => refused(input, {}));
  it('refuses a signedness conversion at the call result', () => refused(input, {functionReturnTypes: {Check: 'uint32_t'}}));
  for (const replacement of ['static int32_t flag', 'extern int32_t flag', 'int32_t flag, other']) {
    it(`refuses declaration shape ${replacement}`, () => refused(input.replace('int32_t flag', replacement)));
  }
  for (const guard of ['if (!flag) return;', 'if (flag < 0) return;', 'if (flag) { Use(flag); return; }', 'if (flag) return; else Use(0);', 'if (flag) { if (Bonus()) return; }']) {
    it(`refuses a different guard: ${guard}`, () => refused(input.replace('if (flag) return;', guard)));
  }
  for (const extra of ['Use(flag);', 'flag = Bonus();', 'Use(&flag);']) {
    it(`refuses an intervening statement: ${extra}`, () => refused(input.replace('if (flag) return;', `${extra} if (flag) return;`)));
  }
  for (const extra of ['Use(&flag);', 'int32_t &alias = flag; Use(alias);', 'again: Use(flag);']) {
    it(`refuses an alias or control-flow entry: ${extra}`, () => refused(input.replace('Use(flag);', extra)));
  }
  it('refuses a shadowed local binding', () => refused(input.replace('Use(flag);', '{ int flag = 1; Use(flag); } Use(flag);')));
  it('refuses a shadowed callee', () => refused(input.replace('void f(int value)', 'void f(int value, int (*Check)(int))')));
  it('refuses self-reference in the initializer', () => refused(input.replace('Check(value)', 'Check(flag)')));
  it('refuses a lambda supplied by a caller constructing the AST', () => {
    const ast = parse(input) as TranslationUnit;
    const fn = ast.declarations[0] as FunctionDecl;
    fn.body!.statements.push({kind: NodeKind.ExprStmt, expression: {
      kind: NodeKind.LambdaExpr, captures: [], captureDefault: '&', parameters: [],
      returnType: null, specifiers: [], body: {kind: NodeKind.CompoundStmt, statements: []},
    } as LambdaExpr} as ExprStmt);
    let site: Vc8FormSite | undefined;
    applyVc8Forms(ast, [{form: parseVc8Form('zerolife(flag)')!}], s => {site = s;}, tables);
    assert.equal(site?.applied, false);
    assert.match(site!.why!, /capture/);
  });

  it('preserves call count, call order and later values at signed word boundaries', {skip: !hasNativeGpp()}, () => {
    const {code, site} = run(); assert.equal(site.applied, true, site.why);
    const unsignedInput = input.replace('int value', 'uint32_t value').replace('int32_t flag', 'uint32_t flag').replace('Check(value)', 'CheckUnsigned(value)');
    const unsigned = run(unsignedInput, {functionReturnTypes: {CheckUnsigned: 'uint32_t'}});
    assert.equal(unsigned.site.applied, true, unsigned.site.why);
    const prelude = `static int trace, calls, bonus; static uint32_t seen;
      int32_t Check(int32_t value) { ++calls; trace = trace * 7 + 1; return value; }
      uint32_t CheckUnsigned(uint32_t value) { ++calls; trace = trace * 7 + 1; return value; }
      int Bonus() { trace = trace * 7 + 2; return bonus; }
      void Use(int32_t value) { trace = trace * 7 + 3; seen = (uint32_t)value; }
      namespace Before { ${input} } namespace After { ${code} }
      namespace BeforeUnsigned { ${unsignedInput} } namespace AfterUnsigned { ${unsigned.code} }`;
    const body = `const int32_t values[] = {INT32_MIN,-65536,-1,0,1,65536,INT32_MAX};
      unsigned checks=0;
      for (unsigned i=0; i<65543; ++i) for (bonus=0; bonus<2; ++bonus) {
        int32_t value = i<65536 ? (int32_t)(i * UINT32_C(65537)) : values[i-65536];
        trace=calls=0;seen=99; Before::f(value); int t=trace,c=calls;uint32_t s=seen;
        trace=calls=0;seen=99; After::f(value);
        if (trace!=t || calls!=c || seen!=s || calls!=1) return 1;
        ++checks;
        trace=calls=0;seen=99; BeforeUnsigned::f((uint32_t)value); t=trace;c=calls;s=seen;
        trace=calls=0;seen=99; AfterUnsigned::f((uint32_t)value);
        if (trace!=t || calls!=c || seen!=s || calls!=1) return 2;
        ++checks;
      }
      printf("%u",checks);`;
    assert.equal(compileAndRun(prelude, body, {optimize: true}).trim(), '262172');
  });
});
