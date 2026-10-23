export { buildCfg, workKey } from './build.js';
export { buildFunctionFlow, ENTRY_DEF, type FunctionFlow, type Definition } from './dataflow.js';
export { preservesReachableWork, type PreservationResult } from './preserve.js';
export {
  collectLabelNames,
  countGotoTargets,
  containsForeignCaseLabel,
  spanIsEnterable,
} from './labels.js';
export type { Cfg, CfgNode, CfgNodeRole, BuildCfgOptions } from './types.js';
export { buildBcfg, resolver, Unsupported, type Bcfg, type BNode, type BcfgOptions } from './bcfg.js';
export { isUnfolding, compareBcfg, type ValidationResult } from './equivalence.js';
export { outParamWidths, calleeSpelling, type OutParamContext } from './out-param.js';
export { paramReaches, countedSinkReach, NO_REACH, type Reach, type ReachField, type ReachParam, type ParamReachContext, type ReachOptions } from './param-reach.js';
