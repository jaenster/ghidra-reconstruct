/**
 * Project configuration
 */

export type {
  ProjectConfig,
  OverrideEntry,
  OverrideAction,
  PatchEntry,
  LibraryEntry,
  LibraryDetectionConfig,
  TargetConfig,
  TargetType,
  AddressRange,
  MethodConversionEntry,
  TypeOwnershipEntry,
  LibrarySignatureDatabase,
  LibrarySignature,
  SignatureHeuristics,
  AutoMethodConversionConfig,
  AdditionalSource,
} from './schema.js';

export {
  loadProjectConfig,
  loadProjectConfigFromFile,
  normalizeAddress,
} from './loader.js';
