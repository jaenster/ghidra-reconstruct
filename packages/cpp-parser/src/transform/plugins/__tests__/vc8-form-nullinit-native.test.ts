import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import {applyVc8Forms,parseVc8Form} from '../builtins/vc8-form.js';
import {compileAndRun,hasNativeGpp} from '../../../testing/native-cpp.js';

const source=`int query(int index) {
  Enter();
  Game* game = games[index];
  Game* token = 0;
  if (game && game != &bad) token = game;
  Leave();
  return Find((uintptr_t)token);
}`;
const sites:boolean[]=[],candidate=emit(applyVc8Forms(parse(source),[{form:parseVc8Form('nullinit(token,@Enter)')!}],s=>sites.push(s.applied)));
assert.deepEqual(sites,[true]);

for(const optimize of [false,true])it(`nullinit preserves protected reads and callbacks (${optimize?'optimized':'unoptimized'})`,{skip:!hasNativeGpp()},()=>{
  const prelude=`
    struct Game { int count,seen; };
    Game a,b,c,bad;Game* games[3];Game* initial[3];
    int mode,current,seed,trace[16],traceCount;
    void Log(int x){trace[traceCount++]=x;}
    void Enter(){Log(1);a.count+=seed;b.count-=seed;c.count+=2*seed;
      if(mode==1)games[current]=&b;else if(mode==2)games[current]=nullptr;else if(mode==3)games[current]=&bad;}
    void Leave(){Log(2);}
    int Find(uintptr_t raw){Game* g=(Game*)raw;Log(!g?10:g==&a?11:g==&b?12:13);if(!g)return -1;g->seen++;return g->count;}
    void Reset(int count){a={count,0};b={count+1,0};c={count+2,0};bad={999,0};for(int i=0;i<3;i++)games[i]=initial[i];traceCount=0;}
    namespace Before { ${source} }
    namespace After { ${candidate} }
  `;
  const body=`unsigned scenarios=0;Game* choices[]={nullptr,&bad,&a,&b,&c};const int counts[]={-2,0,1,127};
    for(current=0;current<3;current++)for(int choice=0;choice<5;choice++)for(mode=0;mode<4;mode++)for(seed=0;seed<7;seed++)for(int count:counts){
      initial[0]=&a;initial[1]=&b;initial[2]=&c;initial[current]=choices[choice];Reset(count);
      int x=Before::query(current),savedTrace[16];int savedCount=traceCount;std::memcpy(savedTrace,trace,sizeof(trace));
      Game aa=a,bb=b,cc=c;Game* savedGames[3];std::memcpy(savedGames,games,sizeof(games));
      Reset(count);int y=After::query(current);
      if(x!=y||traceCount!=savedCount||std::memcmp(trace,savedTrace,savedCount*sizeof(int))||std::memcmp(&a,&aa,sizeof(a))||std::memcmp(&b,&bb,sizeof(b))||std::memcmp(&c,&cc,sizeof(c))||std::memcmp(games,savedGames,sizeof(games)))return 1;
      Game* expected=mode==1?&b:mode==2?nullptr:mode==3?&bad:choices[choice];
      int value=expected==&a?count+seed:expected==&b?count+1-seed:expected==&c?count+2+2*seed:-1;
      if(y!=value||traceCount!=3||trace[0]!=1||trace[1]!=2||trace[2]!=(expected==&a?11:expected==&b?12:expected==&c?13:10))return 2;
      if(a.seen!=(expected==&a)||b.seen!=(expected==&b)||c.seen!=(expected==&c))return 3;
      ++scenarios;
    }std::printf("scenarios=%u\\n",scenarios);
  `;
  const result=compileAndRun(prelude,body,{optimize});assert.match(result,/scenarios=1680/);
});
