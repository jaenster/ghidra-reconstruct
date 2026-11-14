import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopStrideHoistPlugin } from '../builtins/loop-stride-hoist.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

it('preserves a step mutated through implicit C++ reference bindings', { skip: !hasNativeGpp() }, () => {
  const bindings = [
    'StepRef alias = step;',
    'StepRef alias; alias = step;',
    '(StepRef)step;',
    'static_cast<StepRef>(step);',
    'int copied = step + marker;',
    '(step, marker);',
    'indexRef[step];',
    'marker += step;',
    'step += marker;',
  ];
  let prelude = `
    static int *captured;
    struct StepRef {
      StepRef() {}
      StepRef(int &v) { captured = &v; }
      StepRef &operator=(int &v) { captured = &v; return *this; }
    };
    struct Marker { Marker &operator+=(int &v) { captured = &v; return *this; } };
    static Marker marker;
    int operator+(int &v, Marker) { captured = &v; return 0; }
    int operator,(int &v, Marker) { captured = &v; return 0; }
    int &operator+=(int &v, Marker) { captured = &v; return v; }
    struct IndexRef { int operator[](int &v) { captured = &v; return 0; } };
    static IndexRef indexRef;
    void bump() { ++*captured; }
  `;
  let body = 'unsigned checks = 0;';
  bindings.forEach((binding, i) => {
    const source = `int f(int step) { ${binding} int offset = 0;
      do { bump(); offset += step * 4; } while (offset < 256); return offset; }`;
    const before = emit(parse(source, { recover: false }));
    const after = emit(loopStrideHoistPlugin.createTransformer()(parse(source, { recover: false })) as AnyNode);
    prelude += `namespace Before${i} { ${before} } namespace After${i} { ${after} }`;
    // Positive steps and this small bound keep every multiplication and sum in
    // the defined int32 domain. Each binding captures the live parameter, which
    // bump changes before the increment on every iteration.
    body += `for (int step=1; step<=32; ++step) {
      if (Before${i}::f(step) != After${i}::f(step)) return ${i + 1}; ++checks;
    }`;
  });
  body += 'std::printf("checks=%u\\n", checks);';
  assert.equal(compileAndRun(prelude, body, { optimize: true }), 'checks=288\n');
});
