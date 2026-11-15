import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, type ImplGenContext } from '../../codegen/impl.js';
import { setAggregateTypeNames } from '../../codegen/platform-types.js';
import { vc8formBodyHash } from '../../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedStruct, ReconstructOptions } from '../../types.js';

const fixture = JSON.parse(readFileSync(new URL('./ptrwalk-countdown-live-00606890.json', import.meta.url), 'utf8')) as {
  fn: ExtractedFunction; types: ExtractedStruct[]; tables: NonNullable<ImplGenContext['funcPtrArgCasts']>; options: ReconstructOptions;
};
export function countdownImplementation(mode: 'current' | 'none' | 'stale'): string {
  setAggregateTypeNames(fixture.types);
  const dh = mode === 'stale' ? '00000000' : vc8formBodyHash(fixture.fn.decompiled!);
  const tag = `ptrwalk(nColorIndex,pHSLPalette,pdHSLEntry,double);ev=0123456789;bh=144-00000000;dh=${dh}`;
  const fn = { ...fixture.fn, tags: mode === 'none' ? [] : [{ type: 'vc8form', data: tag }] };
  return generateFunctionImplementation(fn, undefined, fixture.options, {
    targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: fixture.tables,
  }, true);
}
