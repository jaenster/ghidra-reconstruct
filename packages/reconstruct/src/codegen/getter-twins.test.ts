import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getterShape } from './getter-twins.js';

describe('getter-twins', () => {
  it('reads GetQuestBitBuffer (00543520) as a getter of one indexed member of a call', () => {
    const body = `{
  D2UnitDataPlayerStrc *pBitBuffer;

  pBitBuffer = D2Common::Units::Units::GetPlayerData(pUnit);
  return pBitBuffer->pQuestRecord[pGame->nDifficulty];
}`;
    assert.deepStrictEqual(getterShape(body, ['pGame', 'pUnit']), {
      callee: 'D2Common::Units::Units::GetPlayerData', calleeArgs: [1], member: 'pQuestRecord', indexParam: 0, indexMember: 'nDifficulty',
    });
  });

  it('takes the expression written whole', () => {
    assert.ok(getterShape('{ return F(b)->a[c->n]; }', ['c', 'b']));
  });

  it('refuses a body that leaves a parameter unused or does more', () => {
    assert.strictEqual(getterShape('{ return F(b)->a[b->n]; }', ['c', 'b']), undefined);
    assert.strictEqual(getterShape('{ G(c); return F(b)->a[c->n]; }', ['c', 'b']), undefined);
    assert.strictEqual(getterShape('{ return F(b)->a[2]; }', ['b']), undefined);
  });
});
