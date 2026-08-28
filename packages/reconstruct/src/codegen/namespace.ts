import { NamespaceResolution, namespaceResolution, renderNamespace, setNamespaceResolution } from './namespace-resolution.js';
/**
 * Namespace and directory management
 *
 * Organizes generated files based on namespace structure
 */

import type {
  ExtractedFunction,
  ExtractedNamespace,
  DetectedClass,
  ReconstructOptions,
} from '../types.js';

/**
 * Template parameter info extracted from a template instantiation
 */
export interface TemplateInfo {
  /** Base template name (e.g., "TSHashTable") */
  baseName: string;
  /** Template parameters as strings */
  params: string[];
  /** Original full name */
  original: string;
  /** Whether this is a template instantiation */
  isTemplate: boolean;
}

/**
 * Parse a potentially templated name and extract template info
 *
 * Examples:
 * - "TSHashTable<struct_CELLIST,class_HASHKEY_NONE>" -> { baseName: "TSHashTable", params: [...], isTemplate: true }
 * - "TSHashTable<CELLIST>" -> { baseName: "TSHashTable", params: ["CELLIST"], isTemplate: true }
 * - "Game::Player" -> { baseName: "Game::Player", params: [], isTemplate: false }
 */
export function parseTemplateName(name: string): TemplateInfo {
  // Check for angle bracket template pattern: Name<params>
  const angleBracketMatch = name.match(/^([A-Za-z_][A-Za-z0-9_:]*)<(.+)>$/);
  if (angleBracketMatch) {
    const baseName = angleBracketMatch[1];
    const paramsStr = angleBracketMatch[2];
    const params = splitTemplateParams(paramsStr);
    return {
      baseName,
      params,
      original: name,
      isTemplate: true,
    };
  }

  // Check for names that contain commas - very likely template instantiations
  // e.g., "TSHashTableReuse_struct_CELLIST,class_HASHKEY_NONE,0"
  if (name.includes(',')) {
    // Find the base name (everything before the first parameter-like part)
    // Parameters often look like: struct_X, class_X, int, 0, etc.
    const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:_|<)(.*)$/);
    if (match) {
      return {
        baseName: match[1],
        params: match[2].split(',').map(p => p.trim()),
        original: name,
        isTemplate: true,
      };
    }
    // Fallback: just take everything before the first comma
    const commaIdx = name.indexOf(',');
    const underscoreBeforeComma = name.lastIndexOf('_', commaIdx);
    if (underscoreBeforeComma > 0) {
      return {
        baseName: name.substring(0, underscoreBeforeComma),
        params: name.substring(underscoreBeforeComma + 1).split(','),
        original: name,
        isTemplate: true,
      };
    }
  }

  // Check for Ghidra's underscore-based template syntax like:
  // TSHashTableReuse_struct_CELLIST (pattern: Name_type_Type)
  // These often have type prefixes like struct_, class_, enum_
  // This also catches single-parameter templates like TSHashTable_CELLIST
  const underscoreTemplateMatch = name.match(/^([A-Za-z_][A-Za-z0-9_]*)_((?:struct|class|enum|union|ptr)_[A-Za-z0-9_,]+|[A-Z][A-Za-z0-9_,]*)$/);
  if (underscoreTemplateMatch) {
    const baseName = underscoreTemplateMatch[1];
    const paramsStr = underscoreTemplateMatch[2];
    const params = paramsStr.split(',').map(p => p.trim());
    return {
      baseName,
      params,
      original: name,
      isTemplate: true,
    };
  }

  return {
    baseName: name,
    params: [],
    original: name,
    isTemplate: false,
  };
}

/**
 * Split template parameters, handling nested templates
 */
function splitTemplateParams(params: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of params) {
    if (char === '<') {
      depth++;
      current += char;
    } else if (char === '>') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Collapse redundant consecutive namespace segments.
 * Core::Tasks::Tasks → Core::Tasks
 * Util::Graph::Graph → Util::Graph
 */
export function collapseConsecutiveDuplicates(name: string): string {
  const parts = name.split('::');
  const collapsed: string[] = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] !== parts[i - 1]) {
      collapsed.push(parts[i]);
    }
  }
  return collapsed.join('::');
}

/**
 * Rewrite a qualified REFERENCE (`Ns::Sub::Sub::sym`) so its qualifier is spelled
 * exactly the way the DECLARATION side spells it.
 *
 * The declaration side runs its namespace through collapseConsecutiveDuplicates()
 * — impl.ts and header.ts both do, and organizeByNamespace() does it via
 * normalizeUnitName(). Reference sites built from Ghidra's raw symbol path (data
 * initializers naming a function, e.g. `&D2Game::Quests::Quests::A1Q6::Fn`) did
 * not, so a `Module::Dir::Dir::Sub` symbol was declared in `Module::Dir::Sub` but
 * referenced through a namespace that does not exist.
 *
 * Only the QUALIFIER is normalized; the trailing symbol name is left alone, so a
 * symbol legitimately named after its own namespace (`Foo::Foo`, a constructor-ish
 * name) keeps both segments.
 */
export function normalizeQualifiedReference(name: string): string {
  const idx = name.lastIndexOf('::');
  if (idx < 0) return name;
  const qualifier = name.slice(0, idx);
  const symbol = name.slice(idx + 2);
  // The reference side resolves the qualifier through the SAME entity the
  // declaration and the definition render from.
  const emitted = renderNamespace(namespaceResolution().resolvePath(qualifier));
  return emitted ? `${emitted}::${symbol}` : symbol;
}

/**
 * Global struct/union/enum type names, registered once per reconstruct run, used
 * to strip a namespace component that collides with a type. The HEADER decl, the
 * IMPL definition, and the call-site rewriter must all strip the SAME component or
 * a function's decl/def/calls land in different namespaces.
 */
export function setNamespaceCollisionTypes(typeNames: Set<string>): void {
  // The type registry is one half of the single namespace rule; installing it
  // installs the resolution every emitter renders from.
  setNamespaceResolution(new NamespaceResolution(typeNames));
}

/**
 * Strip ONLY the LAST namespace component if it collides with a type name —
 * matching the call-site rewriter, which strips a type-name qualifier only when
 * it is PENULTIMATE (directly before the symbol). e.g. `D2Common::Item` → (Item
 * is a struct) → `D2Common`, but `D2Common::Skills::SkillsServer` is left intact
 * (SkillsServer is the last component; an intermediate `Skills` collision is NOT
 * stripped — that would move the def to an unreachable sibling scope).
 */
export function stripLastCollidingNamespaceComponent(ns: string): string | undefined {
  // Kept as a thin adapter for callers that still hold a Ghidra path string.
  // The decision itself is the resolution's, so there is one implementation.
  return renderNamespace(namespaceResolution().resolvePath(ns));
}

/**
 * Extract the "leaf" from a module name by stripping a common library prefix.
 * The default prefix is configurable via setModulePrefix(); e.g. with "Lib"
 * LibGame → Game, LibSound → Sound, and prefix-less names pass through.
 */
let modulePrefix = '';
export function setModulePrefix(prefix: string): void {
  modulePrefix = prefix;
}
function moduleLeaf(moduleName: string): string {
  if (modulePrefix && moduleName.startsWith(modulePrefix)) {
    return moduleName.slice(modulePrefix.length);
  }
  return moduleName;
}

/**
 * Collapse module-leaf redundancy: when segment[0] is a known module and
 * segment[1] matches that module's leaf name, remove segment[1].
 * Audio::Audio::AudioHdr → Audio::AudioHdr
 * Core::Core::View → Core::View
 */
function collapseModuleLeaf(name: string, moduleNames: ReadonlySet<string>): string {
  const parts = name.split('::');
  if (parts.length < 3) return name;
  if (!moduleNames.has(parts[0])) return name;
  const leaf = moduleLeaf(parts[0]);
  if (leaf && parts[1] === leaf) {
    return [parts[0], ...parts.slice(2)].join('::');
  }
  return name;
}

/** Set of known module names, populated by setModuleNames() */
let knownModuleNames: ReadonlySet<string> = new Set();

/**
 * Provide the set of module names from project config so namespace
 * collapsing can handle module-leaf redundancy.
 */
export function setModuleNames(names: Iterable<string>): void {
  knownModuleNames = new Set(names);
}

/**
 * Normalize a namespace/unit name for file organization
 *
 * Collapses redundant namespace segments and groups template instantiations.
 */
export function normalizeUnitName(name: string): string {
  // Skip system-path namespaces entirely (Mac dylib, system libraries)
  if (name.startsWith('/') || name.includes('/usr/') || name.includes('/lib/') || name.startsWith('usr_lib_')) {
    return '_system_excluded';
  }
  let collapsed = collapseConsecutiveDuplicates(name);
  collapsed = collapseModuleLeaf(collapsed, knownModuleNames);
  const templateInfo = parseTemplateName(collapsed);
  if (templateInfo.isTemplate) {
    return templateInfo.baseName;
  }
  return collapsed;
}

/**
 * Organize functions by namespace/class for file generation
 */
export function organizeByNamespace(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  namespaces: ExtractedNamespace[]
): Map<string, ExtractedFunction[]> {
  const organized = new Map<string, ExtractedFunction[]>();

  // Create a map of function addresses to their owning class
  const classMethodMap = new Map<string, string>();
  for (const cls of classes) {
    for (const method of cls.methods) {
      classMethodMap.set(method.address, cls.name);
    }
  }

  // Organize functions
  for (const func of functions) {
    let unitName: string;

    // File placement follows the function's NAMESPACE (its real source module,
    // from the binary) — not its method-conversion class. A function can be a
    // method of ClientStrc (declared in that class's header) while its body
    // belongs to Core::Core::Cmd. Only fall back to the class/_unnamespaced
    // when the function has no namespace of its own.
    const className = classMethodMap.get(func.address);
    if (func.namespace) {
      unitName = normalizeUnitName(func.namespace);
    } else if (className) {
      unitName = normalizeUnitName(className);
    } else {
      unitName = '_unnamespaced';
    }

    if (!organized.has(unitName)) {
      organized.set(unitName, []);
    }
    organized.get(unitName)!.push(func);
  }

  return organized;
}

/**
 * Get file path for a unit (class/namespace)
 */
export function getFilePath(
  unitName: string,
  type: 'header' | 'impl',
  options: ReconstructOptions
): string {
  const ext = type === 'header'
    ? (options.format === 'c' ? '.h' : '.h')
    : (options.format === 'c' ? '.c' : '.cpp');

  switch (options.organization) {
    case 'namespace':
      return getNamespacePath(unitName, ext);

    case 'flat':
      return sanitizeFilename(unitName) + ext;

    case 'module':
      return getModulePath(unitName, ext);

    default:
      return sanitizeFilename(unitName) + ext;
  }
}

/**
 * Get path based on namespace hierarchy
 * e.g., "engine::physics" -> "engine/physics/physics.cpp"
 */
function getNamespacePath(unitName: string, ext: string): string {
  if (unitName === 'globals' || unitName === '__global__' || unitName === '_unnamespaced') {
    return unitName + ext;
  }

  // Split namespace path
  const parts = unitName.split('::');
  const filename = sanitizeFilename(parts[parts.length - 1]);

  if (parts.length === 1) {
    // Single-segment namespaces still get their own directory
    // e.g., "D2OpenGL" -> "D2OpenGL/D2OpenGL.cpp"
    return `${filename}/${filename}${ext}`;
  }

  // Create directory path
  const dirPath = parts.map(sanitizeFilename).join('/');
  return `${dirPath}${ext}`;
}

/**
 * Get path for module organization
 * e.g., "engine::physics" -> "engine.physics/physics.cpp"
 */
function getModulePath(unitName: string, ext: string): string {
  if (unitName === 'globals' || unitName === '__global__' || unitName === '_unnamespaced') {
    return unitName + ext;
  }

  const parts = unitName.split('::');
  const moduleName = parts.join('.');
  const filename = sanitizeFilename(parts[parts.length - 1]);

  return `${moduleName}/${filename}${ext}`;
}

/**
 * Create directory structure for namespace organization
 */
export function createNamespaceDirectory(
  namespaces: ExtractedNamespace[]
): Map<string, string[]> {
  const structure = new Map<string, string[]>();

  for (const ns of namespaces) {
    const parts = ns.fullPath.split('::').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!structure.has(currentPath)) {
        structure.set(currentPath, []);
      }

      if (parentPath && structure.has(parentPath)) {
        const children = structure.get(parentPath)!;
        if (!children.includes(part)) {
          children.push(part);
        }
      }
    }
  }

  return structure;
}

/**
 * Get all directories that need to be created
 */
export function getRequiredDirectories(
  organized: Map<string, ExtractedFunction[]>,
  options: ReconstructOptions
): string[] {
  const dirs = new Set<string>();

  for (const [unitName] of organized) {
    const path = getFilePath(unitName, 'impl', options);
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir) {
      // Add all parent directories
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
  }

  return Array.from(dirs).sort();
}

/**
 * Sanitize a string for use as a filename
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/::/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Generate include path from one file to another
 */
export function getRelativeIncludePath(
  fromPath: string,
  toPath: string
): string {
  const fromParts = fromPath.split('/');
  const toParts = toPath.split('/');

  // Remove filename from 'from' path
  fromParts.pop();

  // Find common prefix
  let commonLength = 0;
  for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
    if (fromParts[i] === toParts[i]) {
      commonLength++;
    } else {
      break;
    }
  }

  // Build relative path
  const upCount = fromParts.length - commonLength;
  const upPath = '../'.repeat(upCount);
  const downPath = toParts.slice(commonLength).join('/');

  return upPath + downPath || toPath;
}

/**
 * Get all includes needed for a file
 */
export function collectIncludes(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  organized: Map<string, ExtractedFunction[]>,
  currentUnit: string,
  options: ReconstructOptions
): string[] {
  const includes = new Set<string>();

  // Collect types used by functions in this unit
  for (const func of functions) {
    // Check parameter types
    for (const param of func.parameters) {
      const typeName = extractTypeName(param.dataType);
      if (typeName && typeName !== currentUnit) {
        const targetPath = getFilePath(typeName, 'header', options);
        includes.add(targetPath);
      }
    }

    // Check return type
    const returnTypeName = extractTypeName(func.returnType);
    if (returnTypeName && returnTypeName !== currentUnit) {
      const targetPath = getFilePath(returnTypeName, 'header', options);
      includes.add(targetPath);
    }
  }

  // Check class base classes and field types
  const cls = classes.find(c => c.name === currentUnit);
  if (cls) {
    for (const baseClass of cls.baseClasses) {
      const targetPath = getFilePath(baseClass, 'header', options);
      includes.add(targetPath);
    }

    for (const field of cls.fields) {
      const typeName = extractTypeName(field.dataType);
      if (typeName && typeName !== currentUnit) {
        const targetPath = getFilePath(typeName, 'header', options);
        includes.add(targetPath);
      }
    }
  }

  return Array.from(includes).sort();
}

/**
 * Extract type name from a type string
 */
function extractTypeName(typeStr: string): string | null {
  // Remove pointer/reference suffixes and const
  const cleaned = typeStr
    .replace(/\*/g, '')
    .replace(/&/g, '')
    .replace(/const\s*/g, '')
    .trim();

  // Skip built-in types
  const builtins = [
    'void', 'int', 'char', 'short', 'long', 'float', 'double',
    'unsigned', 'signed', 'bool', 'size_t', 'uint8_t', 'uint16_t',
    'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  ];

  if (builtins.includes(cleaned) || cleaned === '') {
    return null;
  }

  return cleaned;
}
