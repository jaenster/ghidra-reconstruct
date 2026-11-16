import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,generated} from './initbefore-animdata.fixture.js';
describe('initbefore through the real AnimData decompile',()=>{
  it('preserves the untagged main result',()=>assert.equal(generated(),fixture.baseline));
  it('changes only the measured primitive initialization order',()=>assert.equal(generated(fixture.tag),fixture.candidate));
  it('refuses a stale decompile seal',()=>assert.equal(generated(fixture.tag.replace(/dh=[0-9a-f]{8}/,'dh=ffffffff')),fixture.baseline));
});
