/**
 * C++ Code Emitter Module
 * Pretty printer for emitting C++ code from AST nodes
 */

export { CppEmitter, emit } from './emitter.js';
export {
  type EmitStyle,
  type BraceStyle,
  DEFAULT_STYLE,
  GOOGLE_STYLE,
  LLVM_STYLE,
  GNU_STYLE,
  MICROSOFT_STYLE,
  createStyle,
} from './style.js';
