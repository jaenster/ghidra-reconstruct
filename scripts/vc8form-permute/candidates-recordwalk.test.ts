import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('CLI collector uses actual emitter members, indexes sites and reports the new local',()=>{
  const dir=mkdtempSync(join(tmpdir(),'recordwalk-'));
  try {
    const loop=`for(;n;n-=8+*size){p->data=(unsigned char*)&p->field_0x8; size=&p->size; p=(Record*)(&p->field_0x8+*size);}`;
    const text=`void f(Record* initial,int n){Record* p=initial;unsigned int* size;${loop}}`;
    const items=[{id:'one',text},{id:'two',text:text.replace(/}$/,`p=initial;${loop}}`)},
      {id:'used',text:text.replace(/}$/,`use(p);}`)},
      {id:'unknown',text:text.replace(/Record/g,'Unknown')}];
    const types=[{name:'Record',category:'/',kind:'STRUCTURE',size:9,fields:[
      {name:'size',dataType:'unsigned int',offset:0,size:4},
      {name:'data',dataType:'unsigned char*',offset:4,size:4},
      {name:'',dataType:'undefined',offset:8,size:1},
    ]}];
    writeFileSync(join(dir,'dataTypes.ndjson'),types.map(t=>JSON.stringify(t)).join('\n')+'\n');
    writeFileSync(join(dir,'functions.ndjson'),'');
    writeFileSync(join(dir,'in.json'),JSON.stringify(items));
    const cli=fileURLToPath(new URL('./candidates.ts',import.meta.url));
    const run=(mode:string,input:string,output:string)=>{
      const result=spawnSync(process.execPath,['--import','tsx',cli,mode,join(dir,input),join(dir,output),'--types',join(dir,'dataTypes.ndjson'),'--ops','recordwalk'],{encoding:'utf8'});
      assert.equal(result.status,0,result.stdout+result.stderr);
      return JSON.parse(readFileSync(join(dir,output),'utf8'));
    };
    const rows=run('singles','in.json','out.json');
    for(const row of rows)assert.equal(row.error,undefined);
    assert.deepEqual(rows[0].candidates.map((c:{form:string})=>c.form),['recordwalk(p)']);
    assert.equal(rows[0].candidates[0].adds,1);
    assert.deepEqual(rows[1].candidates.map((c:{form:string})=>c.form),['recordwalk(p,1)','recordwalk(p,2)']);
    assert.deepEqual(rows[2].candidates,[]);
    assert.deepEqual(rows[3].candidates,[]);
    writeFileSync(join(dir,'apply.json'),JSON.stringify([{id:'one',text,forms:['recordwalk(p)']}]));
    const [applied]=run('apply','apply.json','applied.json');
    assert.deepEqual(applied.applied,['recordwalk(p)']);assert.deepEqual(applied.refused,[]);
    assert.equal(applied.text,rows[0].candidates[0].text,'the measured body is the tag-applied body');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
