import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables, type Vc8FormSite } from '../builtins/vc8-form.js';
const facts: Vc8FormTables = { typedefTargets: { uint32_t: 'unsigned int', uint16_t: 'unsigned short', int32_t: 'int' },
  functionParamTypes: { Capture: ['int'] }, structFields: { Payload: { level: 'int', x: 'int', y: 'int' } } };
const packed = '(uint32_t)(uint16_t)y << 16 | (uint32_t)(uint16_t)x';
function run(input: string, tag: string, tables: Vc8FormTables = facts) {
  const ast = parse(input), before = emit(ast), form = parseVc8Form(tag); assert.ok(form);
  const sites: Vc8FormSite[] = [], after = emit(applyVc8Forms(ast, [{ form }], s => sites.push(s), tables));
  assert.equal(emit(ast), before); assert.equal(sites.length, 1); return { before, after, site: sites[0] };
}
function refuses(input: string, tag: string, tables: Vc8FormTables = facts) {
  const r = run(input, tag, tables); assert.equal(r.site.applied, false, input); assert.equal(r.after, r.before);
}
it('parses both explicit forms and refuses missing arguments', () => {
  assert.deepEqual(parseVc8Form('packadd(x,y)'), { op: 'packadd', low: 'x', high: 'y' });
  assert.deepEqual(parseVc8Form('delay(level,(int)count <= 0)'), { op: 'delay', name: 'level', cond: '(int)count <= 0' });
  for (const tag of ['packadd(x)', 'packadd(,y)', 'packadd(x,y,z)', 'delay(x)', 'delay(x,)', 'delay(a.b,x)']) assert.equal(parseVc8Form(tag), undefined);
});
it('writes addition over two explicitly unsigned disjoint halves without mutating its input', () => {
  const r = run(`uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)'); assert.ok(r.site.applied, r.site.why);
  assert.match(r.after, /\(\(uint32_t\)\(uint16_t\)y << 16\) \+ \(uint32_t\)\(uint16_t\)x/);
  const member = run('uint32_t f(Payload p) { return (uint32_t)(uint16_t)p.y << 16 | (uint32_t)(uint16_t)p.x; }', 'packadd(p.x,p.y)');
  assert.ok(member.site.applied, member.site.why);
});
it('refuses overlapping, signed, effectful, volatile and unproved packing operands', () => {
  for (const expr of [packed.replace('<< 16', '<< 8'), packed.replace('(uint16_t)x', 'x'), packed.replace('(uint32_t)(uint16_t)y', '(int)(short)y'), packed.replace('(uint16_t)y', '(uint16_t)Next(y)')]) {
    refuses(`uint32_t f(int x,int y) { return ${expr}; }`, 'packadd(x,y)');
  }
  refuses(`uint32_t f(int x,volatile int y) { return ${packed}; }`, 'packadd(x,y)');
  refuses(`uint32_t f(int x,Other y) { return ${packed}; }`, 'packadd(x,y)');
  refuses(`uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)', {});
  refuses('uint32_t f(Payload p) { return (uint32_t)(uint16_t)p.y << 16 | (uint32_t)(uint16_t)p.x; }', 'packadd(p.x,p.y)',
    { ...facts, structFields: { Payload: { x: 'int', y: 'volatile int' } } });
});
it('refuses local/outer type shadowing and ambiguous packing occurrences', () => {
  refuses(`uint32_t f(int x,int y) { typedef unsigned int uint16_t; return ${packed}; }`, 'packadd(x,y)');
  refuses(`typedef unsigned int uint16_t; uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)');
  refuses(`template<class uint16_t> uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)');
  refuses(`uint32_t f(int x,int y) { uint32_t a=${packed}; return a+(${packed}); }`, 'packadd(x,y)');
});
const prefix = 'Capture(level); Payload p; p.level=level;';
const delay = 'delay(level,(int)count <= 0)';
it('delays a private parameter overwrite while preserving its earlier captured value', () => {
  const r = run(`int f(int32_t level,uint32_t count) { ${prefix} level=count; if((int)count<=0)return 1; return level; }`, delay);
  assert.ok(r.site.applied, r.site.why); assert.match(r.after, /if \(\(int\)count <= 0\)[\s\S]*return 1;[\s\S]*level = count;[\s\S]*return level;/);
  assert.ok(r.after.indexOf('p.level = level;') < r.after.indexOf('level = count;'));
});
it('resolves real Ghidra primitive typedef targets without guessing absent stdint aliases', () => {
  const real = { ...facts, typedefTargets: { uint32_t: 'uint', uint16_t: 'ushort', int32_t: 'int' } };
  assert.ok(run(`uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)', real).site.applied);
  assert.ok(run(`int f(int32_t level,uint32_t count) { ${prefix} level=count; if((int)count<=0)return 1; return level; }`, delay, real).site.applied);
});
it('refuses cyclic aliases even when a qualifier changes the cycle spelling', () => {
  const cyclic = { ...facts, typedefTargets: { ...facts.typedefTargets, uint32_t: 'Alias', Alias: 'const uint32_t' } };
  refuses(`uint32_t f(int x,int y) { return ${packed}; }`, 'packadd(x,y)', cyclic);
  refuses(`int f(int32_t level,uint32_t count) { ${prefix} level=count; if((int)count<=0)return 1; return level; }`, delay, cyclic);
});
it('refuses an escaped parameter, hidden reference contract or unknown destination', () => {
  const wrap = (p: string) => `int f(int level,unsigned int count) { ${p} level=count; if((int)count<=0)return 1; return level; }`;
  for (const p of ['int& alias=level;', 'Leak(&level);', 'Other object=level;']) refuses(wrap(p), delay);
  refuses(wrap('Capture(level);'), delay, { functionParamTypes: { Capture: ['const int&'] } });
  refuses(wrap('Capture(level);'), delay, {});
  refuses(wrap('Payload p; p.level=level;'), delay, {});
  refuses(wrap('Capture(level+other);'), delay);
});
it('refuses observing/effectful guards, nonconstant exits, references and alternate entries', () => {
  for (const [source, tag] of [
    ['int f(int level,unsigned count){level=count;if(level<=0)return 1;return level;}', 'delay(level,level <= 0)'],
    ['int f(int level,unsigned count){level=count;if(Next(count))return 1;return level;}', 'delay(level,Next(count))'],
    ['int f(int level,unsigned count){level=count;if((int)count<=0)return level;return level;}', delay],
    ['int f(int& level,unsigned count){level=count;if((int)count<=0)return 1;return level;}', delay],
    ['int f(int level,volatile unsigned count){level=count;if((int)count<=0)return 1;return level;}', delay],
    ['int f(int level,unsigned count){level=count;skip:if((int)count<=0)return 1;return level;}', delay],
    ['int f(int level,unsigned count){int level=3;level=count;if((int)count<=0)return 1;return level;}', delay],
  ]) refuses(source, tag);
});
