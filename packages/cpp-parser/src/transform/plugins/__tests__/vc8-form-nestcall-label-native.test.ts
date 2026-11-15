import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

for (const optimize of [false, true]) it(`preserves lookup identity, side effects and the save gate (${optimize ? 'optimized' : 'unoptimized'})`, { skip: !hasNativeGpp() }, () => {
  const source = `void f(Unit* unit, int online) {
    Client* client;
    client = Lookup(unit, 0x434);
    Mark(client);
    if (online) { if (!Flags(client)) goto done; }
    int overwrite; overwrite = 0;
    client = Lookup(unit, 0x43a);
    char* name;
    name = Name(client);
    Save(unit, name, overwrite);
  done:
    Finish(unit);
  }`;
  const sites: Vc8FormSite[] = [], ast = parse(source);
  const after = emit(applyVc8Forms(ast, ['nestcall(client,2)', 'nestcall(name)'].map(f => ({ form: parseVc8Form(f)! })), s => sites.push(s), {
    functionReturnTypes: { Lookup: 'Client*', Name: 'char*' },
    functionParamTypes: { Lookup: ['Unit*', 'int'], Mark: ['Client*'], Flags: ['Client*'], Name: ['Client*'], Save: ['Unit*', 'char*', 'int'] },
  }));
  assert.equal(sites.length, 2);
  assert.ok(sites.every(s => s.applied), JSON.stringify(sites));
  const prelude = `
    #include <cstdlib>
    struct Unit { uint32_t seed, flags, state; };
    struct Client { Unit* unit; uint32_t cookie, serial; };
    struct Event { uint32_t kind, argument, seed, flags, state; };
    static Client clients[4]; static char names[4][4];
    static Event trace[16]; static unsigned nTrace, nClient, checks;
    void Log(uint32_t kind, uint32_t argument, Unit* unit) {
      if(nTrace==16) std::abort();
      trace[nTrace++] = {kind, argument, unit->seed, unit->flags, unit->state};
    }
    Client* Lookup(Unit* unit, int line) {
      if(nClient==4) std::abort();
      unsigned index=nClient++; Client* client=&clients[index];
      client->unit=unit; client->serial=index;
      unit->seed = unit->seed*1664525u+1013904223u;
      client->cookie=unit->seed^(uint32_t)line;
      unit->state+=client->cookie;
      Log(1,(uint32_t)line,unit);return client;
    }
    void Mark(Client* client) {
      client->unit->flags^=8u;client->unit->state^=client->cookie;
      Log(2,client->serial,client->unit);
    }
    int Flags(Client* client) {
      client->unit->state+=client->cookie;
      Log(3,client->serial,client->unit);return (int)(client->unit->flags&1u);
    }
    char* Name(Client* client) {
      names[client->serial][0]=(char)(client->cookie&0x7fu);
      client->unit->state^=client->cookie;
      Log(4,client->serial,client->unit);return names[client->serial];
    }
    void Save(Unit* unit, char* name, int overwrite) {
      unsigned index=4;for(unsigned i=0;i<4;i++)if(name==names[i])index=i;
      if(index==4 || overwrite)std::abort();
      unit->state+=(uint32_t)(unsigned char)name[0];Log(5,index,unit);
    }
    void Finish(Unit* unit) { Log(6,unit->state,unit); }
    namespace Before { ${emit(ast)} }
    namespace After { ${after} }
    void Reset() { nTrace=nClient=0;std::memset(trace,0,sizeof(trace));std::memset(clients,0,sizeof(clients));std::memset(names,0,sizeof(names)); }
    bool Check(uint32_t seed,uint32_t flags,int online) {
      Unit a={seed,flags,0},b=a;Reset();Before::f(&a,online);
      Event expected[16];std::memcpy(expected,trace,sizeof(trace));unsigned count=nTrace,clientCount=nClient;
      uint32_t cookies[4],serials[4];for(unsigned i=0;i<4;i++){cookies[i]=clients[i].cookie;serials[i]=clients[i].serial;}
      char expectedNames[4][4];std::memcpy(expectedNames,names,sizeof(names));
      Reset();After::f(&b,online);
      if(std::memcmp(&a,&b,sizeof(a)) || count!=nTrace || clientCount!=nClient || std::memcmp(expected,trace,sizeof(trace)) || std::memcmp(expectedNames,names,sizeof(names)))return false;
      for(unsigned i=0;i<clientCount;i++)if(clients[i].unit!=&b || clients[i].cookie!=cookies[i] || clients[i].serial!=serials[i])return false;
      ++checks;return true;
    }
  `;
  const body = `
    for(uint32_t flags=0;flags<65536;flags++)for(int online=0;online<2;online++) {
      if(!Check(0,flags,online)||!Check(UINT32_MAX,flags,online))return 1;
    }
    const uint32_t seeds[]={1,0x7fffffffu,0x80000000u,0xfffffffeu};
    const uint32_t flags[]={0,1,8,0x80000000u,0xffffffffu};
    for(uint32_t seed:seeds)for(uint32_t flag:flags)for(int online=0;online<2;online++)if(!Check(seed,flag,online))return 2;
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize }), 'checks=262184\n');
});
