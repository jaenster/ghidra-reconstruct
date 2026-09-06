export { buildCfg, workKey } from './build.js';
export { preservesReachableWork, type PreservationResult } from './preserve.js';
export {
  collectLabelNames,
  countGotoTargets,
  containsForeignCaseLabel,
  spanIsEnterable,
} from './labels.js';
export type { Cfg, CfgNode, CfgNodeRole, BuildCfgOptions } from './types.js';
