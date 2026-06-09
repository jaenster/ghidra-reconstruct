import { parse } from './src/parser/index.js';

const ast = parse('void f() { D2SeedStrc x = (D2SeedStrc)(a * 0x6ac690c5 + b); }');

function findNode(node: any, kind: string): any {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (node.kind === kind) return node;
  for (const v of Object.values(node) as any[]) {
    if (Array.isArray(v)) { for (const e of v) { const r = findNode(e, kind); if (r) return r; } }
    else { const r = findNode(v, kind); if (r) return r; }
  }
  return null;
}

const cast = findNode(ast, 'CStyleCastExpr');
if (cast) {
  console.log('Cast type kind:', cast.type.kind);
  console.log('Cast type:', JSON.stringify(cast.type, (k, v) => k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' ? undefined : v, 2));
  console.log('Expr kind:', cast.expression.kind);

  const binAdd = findNode(cast, 'BinaryExpr');
  if (binAdd) {
    console.log('\nBinaryExpr operator:', binAdd.operator);
    console.log('Left kind:', binAdd.left.kind, binAdd.left.operator || '');
    console.log('Right kind:', binAdd.right.kind);
  }
}

// Now test a more realistic one
console.log('\n--- Realistic pattern ---');
const ast2 = parse('void f() { D2SeedStrc x = (D2SeedStrc)((uint64_t)(uint32_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pUnit->sSeed.nSeedHigh); }');
const cast2 = findNode(ast2, 'CStyleCastExpr');
if (cast2 && cast2.type) {
  // Find all MemberExprs
  function findAll(node: any, kind: string, results: any[] = []): any[] {
    if (node === null || node === undefined || typeof node !== 'object') return results;
    if (node.kind === kind) results.push(node);
    for (const v of Object.values(node) as any[]) {
      if (Array.isArray(v)) { for (const e of v) findAll(e, kind, results); }
      else findAll(v, kind, results);
    }
    return results;
  }

  const members = findAll(cast2, 'MemberExpr');
  for (const m of members) {
    const memberName = m.member?.name || '?';
    console.log(`  MemberExpr: .${memberName} (arrow=${m.isArrow})`);
  }
}
