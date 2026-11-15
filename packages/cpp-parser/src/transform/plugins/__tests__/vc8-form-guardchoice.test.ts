import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { FunctionDecl, IfStmt } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const source = 'int f(int whole, int fraction) { if (!whole) { if (!fraction) return Reject(); } else if (!fraction) { Integral(); goto tail; } Decimal(); tail: Append(); return 1; }';
const facts: Vc8FormTables = { functionReturnTypes: { Integral:'void', Decimal:'void' }, functionParamTypes: { Integral:[], Decimal:[] } };
function run(code = source, spelling = 'guardchoice(whole,fraction)', tables: Vc8FormTables = facts) {
  const before = emit(parse(code)), sites: Vc8FormSite[] = [], form = parseVc8Form(spelling); assert.ok(form);
  const after = emit(applyVc8Forms(parse(code), [{ form }], s => sites.push(s), tables)); assert.equal(sites.length, 1);
  return { before, after, site: sites[0] };
}
function refuse(code: string) { const r = run(code); assert.equal(r.site.applied, false, r.after); assert.equal(r.after, r.before); }

describe('guardchoice', () => {
  it('rejects only zero/zero, then selects the same call and retains the shared label', () => {
    const r = run(); assert.ok(r.site.applied, r.site.why);
    assert.match(r.after, /if \(!whole && !fraction\)\s*{\s*return Reject\(\);/);
    assert.match(r.after, /if \(fraction\)\s*{\s*Decimal\(\);\s*} else {\s*Integral\(\);/);
    assert.match(r.after, /tail:\s*Append\(\);/); assert.doesNotMatch(r.after, /goto tail/);
    for (const name of ['Reject','Integral','Decimal','Append']) assert.equal((r.after.match(new RegExp(name+'\\(', 'g')) ?? []).length, 1);
  });
  for (const [a,b] of [['whole == 0','fraction == 0'],['0 == whole','0 == fraction'],['!(whole)','!(fraction)']]) it(`accepts equivalent primitive tests ${a} / ${b}`, () => {
    const r = run(source.replace('!whole',a).replace(/!fraction/g,b)); assert.ok(r.site.applied,r.site.why);
  });
  it('accepts initialized top-level integer locals and braces around the else-if', () => {
    const code=source.replace('int whole, int fraction','int a, int b').replace('{ if (!whole)','{ int whole=a; int fraction=b; if (!whole)').replace('else if (!fraction) { Integral(); goto tail; }','else { if (!fraction) { Integral(); goto tail; } }');
    assert.ok(run(code).site.applied);
  });
  it('preserves another goto entering the common tail', () => {
    const r=run(source.replace('{ if (!whole)','{ if (whole == 99) goto tail; if (!whole)')); assert.ok(r.site.applied,r.site.why);assert.equal((r.after.match(/goto tail/g)??[]).length,1);
  });
  it('permits an existing escaped slot without changing its identity or call arguments', () => {
    const r=run(source.replace('{ if (!whole)','{ Remember(&whole, &fraction); if (!whole)').replace('Integral()','Integral(&whole, &fraction)').replace('Decimal()','Decimal(&whole, &fraction)'),undefined,{...facts,functionParamTypes:{Integral:['int *','int *'],Decimal:['int *','int *']}});assert.ok(r.site.applied,r.site.why);assert.match(r.after,/Integral\(&whole, &fraction\)/);
  });
  for (const type of ['bool','char','unsigned char','short','unsigned short','int','unsigned int','long','unsigned long','long long','const int']) it(`accepts builtin ${type}`,()=>assert.ok(run(source.replace('int whole',`${type} whole`).replace('int fraction',`${type} fraction`)).site.applied));
  for (const type of ['Value','Other::int32_t','int32_t','BOOL','float','double','volatile int','const volatile int','int &','int *']) it(`refuses unknown, volatile or non-builtin type ${type}`,()=>refuse(source.replace('int whole',`${type} whole`)));
  for (const name of ['whole','fraction']) it(`refuses shadowed ${name}`,()=>refuse(source.replace('return 1;',`{ int ${name}=9; } return 1;`)));
  it('refuses globals and a later declaration that could hide an earlier global',()=>{
    refuse(source.replace('int whole, ','').replace('int f(int fraction)','int f(int fraction)'));
    refuse(source.replace('int whole, ','').replace('return 1;','int whole=8; return 1;'));
    refuse(source.replace('int whole, ','').replace('{ if (!whole)','{ { int whole=8; } if (!whole)'));
  });
  for (const test of ['Read()','whole++','!other','whole < 0','!(whole + 0)']) it(`refuses first test ${test}`,()=>refuse(source.replace('!whole',test)));
  it('requires both second tests to be the same zero test',()=>refuse(source.replace('else if (!fraction)','else if (fraction)')));
  for(const tables of [{},{...facts,functionParamTypes:{}},{...facts,functionReturnTypes:{}},{...facts,functionParamTypes:{Integral:['int'],Decimal:[]}}, {...facts,globalTypes:{Integral:'Callable'}}, {...facts,enclosingVarTypes:{'Scope::Integral':'Callable'},enclosingSegments:['Scope']}])it('refuses absent/incompatible callable facts or callable shadowing',()=>{const r=run(source,undefined,tables);assert.equal(r.site.applied,false);assert.equal(r.after,r.before);});
  it('refuses a local callable and resolves declared functions in the enclosing namespace',()=>{
    refuse(source.replace('{ if (!whole)','{ Callable Integral; if (!whole)'));
    const r=run(source,undefined,{functionReturnTypes:{'Scope::Integral':'void','Scope::Decimal':'void'},functionParamTypes:{'Scope::Integral':[],'Scope::Decimal':[]},enclosingSegments:['Scope']});assert.ok(r.site.applied,r.site.why);
  });
  for (const extra of ['Observe(); Integral();','int local=9; Integral();','Integral(); Observe();']) it(`refuses extra branch work ${extra}`,()=>refuse(source.replace('Integral();',extra)));
  for (const noncall of ['value = Decimal();','int local = Decimal();','return Decimal();','whole++;']) it(`refuses a following non-call statement ${noncall}`,()=>refuse(source.replace('Decimal();',noncall)));
  it('requires the adjacent goto to target the immediately shared label',()=>{
    refuse(source.replace('goto tail','goto elsewhere'));refuse(source.replace('Decimal(); tail:','Decimal(); Observe(); tail:'));refuse(source.replace('goto tail;','return 1;'));
  });
  it('refuses a nested site and ambiguous repeated sites atomically',()=>{
    refuse(source.replace('{ if (!whole)','{ { if (!whole)').replace('return 1;','} return 1;'));
    const pair='if (!whole) { if (!fraction) return Reject(); } else if (!fraction) { Integral(); goto other; } Decimal(); other: Append();';
    refuse(source.replace('return 1;',pair+' return 1;'));
  });
  for (const opaque of ['typedef int Alias;','struct Local {};','void Local();','__try { Work(); } __except(1) { Recover(); }']) it(`refuses opaque local syntax ${opaque}`,()=>refuse(source.replace('{ if (!whole)',`{ ${opaque} if (!whole)`)));
  it('refuses an if initializer without mutation',()=>{
    const tu=parse(source),fn=tu.declarations[0]as FunctionDecl;(fn.body!.statements[0]as IfStmt).init=(parse('void h(){int x=0;}').declarations[0]as FunctionDecl).body!.statements[0];const before=emit(tu),sites:Vc8FormSite[]=[];assert.equal(emit(applyVc8Forms(tu,[{form:parseVc8Form('guardchoice(whole,fraction)')!}],s=>sites.push(s),facts)),before);assert.equal(sites[0].applied,false);
  });
  for(const spelling of ['guardchoice()','guardchoice(whole)','guardchoice(whole,whole)','guardchoice(whole,fraction,@1)','guardchoice(whole,fraction,other)','guardchoice(1,fraction)','guardchoice(whole,p->fraction)'])it(`rejects invalid spelling ${spelling}`,()=>assert.equal(parseVc8Form(spelling),undefined));
});
