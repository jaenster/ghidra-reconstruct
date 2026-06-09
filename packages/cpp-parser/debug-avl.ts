import { parse } from './src/parser/index.js';
import { emit } from './src/emit/index.js';
import type { AnyNode } from './src/ast/nodes.js';
import { gotoCleanupPlugin } from './src/transform/plugins/builtins/goto-cleanup/index.js';
import { resetGotoCleanupStats, getGotoCleanupStats } from './src/transform/plugins/builtins/goto-cleanup/index.js';

const code = `int32_t AUTOMAP_InsertCellIntoTree(D2AutomapCellStrc* pAutomapCell1, D2AutomapCellStrc* pAutomapCell2) {
    int i3;
    int32_t i1;
    D2AutomapCellStrc* var_8;
    D2AutomapCellStrc* pDVar2;
    short int s1;
    pDVar2 = pAutomapCell2->fSaved;
    if (pDVar2 == nullptr) {
      pAutomapCell1->pLess = nullptr;
      pAutomapCell1->pMore = nullptr;
      pAutomapCell1->wWeight = 0;
      i1 = 1;
      goto label_00457c17;
    }
    i3 = (int)pAutomapCell1->yPixel - (int)pDVar2->yPixel;
    if ((!i3) && (i3 = (int)pAutomapCell1->xPixel - (int)pDVar2->xPixel, !i3)) {
      if (((&gnAutoMapCellPriority)[pAutomapCell1->nCellNo] == -1) || ((&gnAutoMapCellPriority)[pAutomapCell1->nCellNo] == (&gnAutoMapCellPriority)[pDVar2->nCellNo])) {
        pAutomapCell2->fSaved = pDVar2;
        return 0;
      }
      i3 = (int)pAutomapCell1->nCellNo - (int)pDVar2->nCellNo;
    }
    var_8 = pDVar2;
    if (i3 < 0) {
      i1 = AUTOMAP_InsertCellIntoTree(pAutomapCell1, (D2AutomapCellStrc*)&pDVar2->pLess);
      pAutomapCell1 = pDVar2;
      if (!i1) {
        label_00457c17:
        pAutomapCell2->fSaved = pAutomapCell1;
        return i1;
      }
      s1 = pDVar2->wWeight;
      if (s1 == -1) {
        AUTOMAP_RebalanceTreeRight((int*)&var_8);
        pAutomapCell2->fSaved = var_8;
        return 0;
      }
      if (!s1) {
        pDVar2->wWeight = -1;
        pAutomapCell2->fSaved = pDVar2;
        return i1;
      }
      if (!s1)
        goto label_00457c17;
    } else {
      if (i3 < 1) {
        pAutomapCell2->fSaved = pDVar2;
        return 0;
      }
      i1 = AUTOMAP_InsertCellIntoTree(pAutomapCell1, (D2AutomapCellStrc*)&pDVar2->pMore);
      pAutomapCell1 = pDVar2;
      if (!i1)
        goto label_00457c17;
      s1 = pDVar2->wWeight;
      if (s1 != -1) {
        if (!s1) {
          pDVar2->wWeight = 1;
          pAutomapCell2->fSaved = pDVar2;
          return i1;
        }
        if (s1) {
          AUTOMAP_RebalanceTreeLeft((int*)&var_8);
          pAutomapCell2->fSaved = var_8;
          return 0;
        }
        goto label_00457c17;
      }
    }
    pDVar2->wWeight = 0;
}`;

resetGotoCleanupStats();
const ast = parse(code);
const transformer = gotoCleanupPlugin.createTransformer();
const result = transformer(ast);
const output = emit(result as AnyNode);
console.log(output);
console.log('\n--- Stats ---');
console.log(getGotoCleanupStats());
