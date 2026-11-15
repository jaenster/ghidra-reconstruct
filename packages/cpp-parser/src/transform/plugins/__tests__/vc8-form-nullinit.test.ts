import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import {NodeKind} from '../../../ast/kinds.js';
import type {DeclStmt,FunctionDecl,LambdaExpr,VariableDecl} from '../../../ast/nodes.js';
import {applyVc8Forms,parseVc8Form,type Vc8FormSite} from '../builtins/vc8-form.js';

function run(code:string,tag='nullinit(token,@Enter)') {
  const form=parseVc8Form(tag);assert.ok(form);const sites:Vc8FormSite[]=[];
  const before=emit(parse(code)),after=emit(applyVc8Forms(parse(code),[{form}],s=>sites.push(s)));
  assert.equal(sites.length,1);return {before,after,site:sites[0]};
}
const body=(statements:string)=>`int f(int index) { ${statements} return Find((uint32_t)token); }`;

describe('vc8-form nullinit',()=>{
  it('parses one local and a named call anchor',()=>{
    assert.deepEqual(parseVc8Form('nullinit(token,@Enter)'),{op:'nullinit',name:'token',before:'Enter'});
    assert.deepEqual(parseVc8Form('nullinit(token,@Win::Enter)'),{op:'nullinit',name:'token',before:'Win::Enter'});
    for(const s of ['nullinit(token)','nullinit(token,Enter)','nullinit(a.b,@Enter)','nullinit(token,@obj->Enter)','nullinit(token,@Enter,1)','nullinit(token,other,@Enter)'])assert.equal(parseVc8Form(s),undefined,s);
  });
  for(const zero of ['0','nullptr','(0)','0x0u'])it(`moves literal ${zero} without moving the protected read`,()=>{
    const r=run(body(`Enter(); Game* game = games[index]; Game* token = ${zero}; if(game) token=game;`));
    assert.equal(r.site.applied,true);assert.ok(r.after.indexOf('token =')<r.after.indexOf('Enter()'));assert.ok(r.after.indexOf('games[index]')>r.after.indexOf('Enter()'));assert.match(r.after,/if \(game\)/);
  });
  it('accepts namespace qualification and unrelated declarations between the call and local',()=>{
    const r=run(body('Win::Enter(); int bucket=0; Game* token=0; token=games[bucket];'),'nullinit(token,@Enter)');assert.equal(r.site.applied,true);
  });
  const refusals:[string,string][]=[
    ['non-null value',body('Enter(); Game* token=game;')],
    ['pointer load',body('Enter(); Game* token=games[index];')],
    ['initializer call',body('Enter(); Game* token=Make();')],
    ['cast initializer',body('Enter(); Game* token=(Game*)0;')],
    ['integer local',body('Enter(); uint32_t token=0;')],
    ['object local',body('Enter(); Box token=0;')],
    ['volatile pointer',body('Enter(); Game* volatile token=0;')],
    ['volatile pointee',body('Enter(); volatile Game* token=0;')],
    ['const pointer',body('Enter(); Game* const token=0;')],
    ['static storage',body('Enter(); static Game* token=0;')],
    ['extern storage',body('Enter(); extern Game* token;')],
    ['direct initialization',body('Enter(); Game* token(0);')],
    ['list initialization',body('Enter(); Game* token={0};')],
    ['pointer to array',body('Enter(); int (*token)[4]=0;')],
    ['function pointer',body('Enter(); void (*token)()=0;')],
    ['unknown pointer alias',body('Enter(); GamePtr token=0;')],
    ['explicit address',body('Enter(); Game* token=0; Observe(&token);')],
    ['unknown reference argument',body('Enter(); Game* token=0; Observe(token);')],
    ['addressof',body('Enter(); Game* token=0; std::addressof(token);')],
    ['reference binding',body('Enter(); Game* token=0; Game*& alias=token;')],
    ['reference cast',body('Enter(); Game* token=0; Observe((Game*&)token);')],
    ['shadowed binding',body('Enter(); Game* token=0; { Game* token=0; }')],
    ['multiple declarations',body('Enter(); Game* token=0,*other=0;')],
    ['global name use',body('Use(token); Enter(); Game* token=0;')],
    ['anchor uses the name',body('Enter(token); Game* token=0;')],
    ['already before call',body('Game* token=0; Enter();')],
    ['ambiguous calls',body('Enter(); Enter(); Game* token=0;')],
    ['same leaf in different namespaces',body('Win::Enter(); Other::Enter(); Game* token=0;')],
    ['nested duplicate call',body('Enter(); if(index) Enter(); Game* token=0;')],
    ['nested only anchor',body('if(index) Enter(); Game* token=0;')],
    ['non-standalone call',body('int ok=Enter(); Game* token=0;')],
    ['nested local','int f(){ Enter(); if(ready) { Game* token=0; return Find((uint32_t)token); } return 0; }'],
    ['control between',body('Enter(); if(index) Check(); Game* token=0;')],
    ['local type between',body('Enter(); typedef Game Other; Game* token=0;')],
    ['type value binding between',body('Enter(); int Game=1; Game* token=0;')],
    ['goto',body('Enter(); Game* token=0; goto done; done:;')],
    ['parameter collision','int f(Game* token){ Enter(); Game* token=0; return 0; }'],
    ['local callable','int f(void (*Enter)()){ Enter(); Game* token=0; return Find((uint32_t)token); }'],
  ];
  for(const[name,code]of refusals)it(`refuses ${name} without changing the AST`,()=>{const r=run(code);assert.equal(r.site.applied,false);assert.equal(r.after,r.before)});
  it('refuses a lambda AST without moving the declaration',()=>{
    const tu=parse('int f(){ Enter(); Game* token=0; Fn read=0; return Find((uint32_t)token); } int body(){ return token; }');
    const fn=tu.declarations[0] as FunctionDecl,decl=(fn.body!.statements[2] as DeclStmt).declarations[0] as VariableDecl;
    decl.initializer={kind:NodeKind.LambdaExpr,captures:[],captureDefault:'&',parameters:[],returnType:null,body:(tu.declarations[1] as FunctionDecl).body!,specifiers:[],location:decl.location} as LambdaExpr;
    tu.declarations=[fn];const before=emit(tu),sites:Vc8FormSite[]=[];
    const after=emit(applyVc8Forms(tu,[{form:parseVc8Form('nullinit(token,@Enter)')!}],s=>sites.push(s)));
    assert.equal(sites[0].applied,false);assert.equal(after,before);
  });
});
