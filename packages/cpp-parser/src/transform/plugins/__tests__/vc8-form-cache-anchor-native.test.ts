import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

// Captured integer results remain private while callbacks mutate pointed-to
// state. The two cache lifetimes must stay separate, including zero/negative
// results, early exits and a corpse that aliases the caster.
const source = `int redemption(Unit* unit, Unit* corpse, int skill, int skip) {
  if (skill < 0 || skill >= 2 || !corpse) return 0;
  if (!Selectable(corpse)) return 0;
  int value;
  if (!skip) {
    value = Calc(unit, 0);
    unsigned chance = Roll(unit);
    if ((int)chance >= value) return 0;
  }
  value = Calc(unit, 1);
  int maximum = MaxLife(unit);
  int current = Current(unit, 6);
  current += value * 256;
  if (maximum < current) current = maximum;
  Set(unit, 6, current);
  value = Calc(unit, 2);
  maximum = MaxMana(unit);
  current = Current(unit, 8);
  current += value * 256;
  if (maximum < current) current = maximum;
  Set(unit, 8, current);
  Mark(corpse);
  return 1;
}`;
const forms = [
  'cache(value * 256,life,int,@maximum,1,1)',
  'cache(value * 256,mana,int,@maximum,1,2)',
].map(s => { const form = parseVc8Form(s); assert.ok(form); return { form }; });
const applied: boolean[] = [];
const candidate = emit(applyVc8Forms(parse(source), forms, s => applied.push(s.applied)));
assert.deepEqual(applied, [true, true]);

for (const optimize of [false, true]) it(`indexed cache lifetimes preserve callback traces (${optimize ? 'optimized' : 'unoptimized'})`, { skip: !hasNativeGpp() }, () => {
  const prelude = `
    struct Unit { int life,mana; unsigned seed,flags,marked; };
    int lifeGain,manaGain,selectable;
    unsigned trace[128], traceCount;
    void Log(unsigned v) { if(traceCount < 128) trace[traceCount++]=v; }
    int Selectable(Unit*) { Log(1); return selectable; }
    int Calc(Unit*,int kind) { Log(10+kind);return kind==0 ? 50 : kind==1 ? lifeGain : manaGain; }
    unsigned Roll(Unit* u) { Log(20);unsigned value=u->seed%100;u->seed+=3;return value; }
    int MaxLife(Unit* u) { Log(30);u->life+=1;return 10000; }
    int MaxMana(Unit* u) { Log(31);u->mana+=2;return 8000; }
    int Current(Unit* u,int stat) { Log(40+stat);return stat==6?u->life:u->mana; }
    void Set(Unit* u,int stat,int value) { Log(60+stat);Log((unsigned)value);if(stat==6)u->life=value;else u->mana=value; }
    void Mark(Unit* u) { Log(80);u->marked=1;u->flags&=~6u; }
    namespace Before { ${source} }
    namespace After { ${candidate} }
  `;
  const body = `unsigned scenarios=0;const int gains[]={-1000,-2,-1,0,1,2,1000};const unsigned seeds[]={0,49,50,99};
    for(int life:gains)for(int mana:gains)for(int cur=-512;cur<=512;cur+=512)for(int skill=-1;skill<=2;skill++)
    for(int corpseMode=0;corpseMode<3;corpseMode++)for(int chosen=0;chosen<2;chosen++)for(int skip=0;skip<2;skip++)for(unsigned seed:seeds){
      lifeGain=life;manaGain=mana;selectable=chosen;
      Unit unit={cur,cur,seed,15,0},corpse={7,9,0,15,0};
      Unit* target=corpseMode==0?nullptr:corpseMode==1?&corpse:&unit;
      traceCount=0;std::memset(trace,0,sizeof(trace));int a=Before::redemption(&unit,target,skill,skip);
      Unit beforeUnit=unit,beforeCorpse=corpse;unsigned beforeTrace[128];std::memcpy(beforeTrace,trace,sizeof(trace));unsigned count=traceCount;
      unit={cur,cur,seed,15,0};corpse={7,9,0,15,0};traceCount=0;std::memset(trace,0,sizeof(trace));
      int b=After::redemption(&unit,target,skill,skip);
      bool valid=skill>=0&&skill<2&&corpseMode!=0&&chosen;
      bool expected=valid&&(skip||seed%100<50);
      if(a!=b||a!=(int)expected||count!=traceCount||std::memcmp(beforeTrace,trace,sizeof(trace))||
        std::memcmp(&unit,&beforeUnit,sizeof(unit))||std::memcmp(&corpse,&beforeCorpse,sizeof(corpse)))return 1;
      unsigned expectedSeed=seed+(valid&&!skip?3:0);if(unit.seed!=expectedSeed)return 2;
      if(expected){int el=cur+1+life*256,em=cur+2+mana*256;if(el>10000)el=10000;if(em>8000)em=8000;
        if(unit.life!=el||unit.mana!=em||!target->marked||(target->flags&6u))return 3;
      }else if(unit.life!=cur||unit.mana!=cur)return 4;
      ++scenarios;
    }
    std::printf("scenarios=%u\\n",scenarios);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize }), 'scenarios=28224\n');
});
