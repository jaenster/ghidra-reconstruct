/**
 * Analysis orchestration
 *
 * Coordinates analysis passes over extracted data
 */

export { analyzeScoping, type ScopingResult } from './scoping.js';
export { detectClasses, type ClassDetectionResult } from './classes.js';
export { buildCallGraph, populateCalledFunctions, type CallGraphResult } from './callgraph.js';
export { analyzeStaticPromotion, type StaticPromotionResult } from './static.js';
export {
  buildDependencyGraph,
  parseTypeString,
  isBuiltinType,
  generateIncludes,
  DependencyGraph,
  type SymbolReference,
  type SymbolNode,
  type ReferenceUsage,
} from './references.js';

import type {
  ExtractedFunction,
  ExtractedGlobal,
  ExtractedDataType,
  ExtractedNamespace,
  ExtractedStruct,
  GhidraConnection,
  DetectedClass,
  CallGraph,
  ScopingAnalysis,
} from '../types.js';

import { analyzeScoping } from './scoping.js';
import { detectClasses } from './classes.js';
import { buildCallGraph, populateCalledFunctions } from './callgraph.js';
import { analyzeStaticPromotion } from './static.js';
import { buildDependencyGraph, DependencyGraph } from './references.js';

/**
 * Complete analysis result
 */
export interface AnalysisResult {
  /** Call graph for the program */
  callGraph: CallGraph;

  /** Detected classes from vtables and patterns */
  classes: DetectedClass[];

  /** Scoping analysis results (which globals should be static) */
  scopingAnalysis: ScopingAnalysis[];

  /** Globals that should be promoted to static */
  staticPromotions: Map<string, string>;

  /** Function organization by file/class */
  functionOrganization: Map<string, string[]>;

  /** Symbol dependency graph for include/module generation */
  dependencyGraph: DependencyGraph;
}

/**
 * Options for analysis
 */
export interface AnalysisOptions {
  /** Detect classes from vtables and patterns */
  detectClasses?: boolean;

  /** Analyze global scoping for static promotion */
  analyzeScoping?: boolean;

  /** Build call graph */
  buildCallGraph?: boolean;

  /** Connection for additional queries (optional, for class detection) */
  connection?: GhidraConnection;
}

/**
 * Run all analysis passes over extracted data
 */
export async function analyzeAll(
  functions: ExtractedFunction[],
  globals: ExtractedGlobal[],
  dataTypes: ExtractedDataType[],
  namespaces: ExtractedNamespace[],
  options: AnalysisOptions = {}
): Promise<AnalysisResult> {
  const {
    detectClasses: doDetectClasses = true,
    analyzeScoping: doAnalyzeScoping = true,
    buildCallGraph: doBuildCallGraph = true,
    connection,
  } = options;

  // Handle potentially undefined inputs
  const safeFunctions = functions || [];
  const safeGlobals = globals || [];
  const safeDataTypes = dataTypes || [];
  const safeNamespaces = namespaces || [];

  // Build call graph (used by other analyses)
  const callGraph = doBuildCallGraph
    ? buildCallGraph(safeFunctions)
    : { nodes: new Map(), edges: new Map() };

  // Populate calledFunctions on each ExtractedFunction from the call graph
  if (doBuildCallGraph) {
    populateCalledFunctions(safeFunctions, callGraph);
  }

  // Filter data types to only actual structs (they have 'fields' property)
  const structs = safeDataTypes.filter(
    (dt): dt is ExtractedStruct => dt.kind === 'STRUCTURE' && 'fields' in dt
  );

  // Detect classes from vtables and struct patterns
  const classes = doDetectClasses
    ? await detectClasses(safeFunctions, structs, safeNamespaces, connection)
    : [];

  // Analyze global scoping
  const scopingAnalysis = doAnalyzeScoping
    ? analyzeScoping(safeGlobals, safeFunctions)
    : [];

  // Determine static promotions
  const staticPromotions = new Map<string, string>();
  for (const analysis of scopingAnalysis) {
    if (analysis.shouldBeStatic && analysis.suggestedLocation) {
      staticPromotions.set(analysis.globalId, analysis.suggestedLocation);
    }
  }

  // Organize functions by file/class
  const functionOrganization = organizeFunctions(safeFunctions, classes, safeNamespaces);

  // Build dependency graph for include/module generation
  const dependencyGraph = buildDependencyGraph(safeFunctions, safeDataTypes, safeGlobals);

  return {
    callGraph,
    classes,
    scopingAnalysis,
    staticPromotions,
    functionOrganization,
    dependencyGraph,
  };
}

/**
 * Organize functions into files based on namespace/class membership
 */
function organizeFunctions(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  namespaces: ExtractedNamespace[]
): Map<string, string[]> {
  const organization = new Map<string, string[]>();

  // Create a map of class addresses to class names
  const classMethodMap = new Map<string, string>();
  for (const cls of classes) {
    for (const method of cls.methods) {
      classMethodMap.set(method.address, cls.name);
    }
  }

  for (const func of functions) {
    let targetFile: string;

    // Check if function belongs to a detected class
    const className = classMethodMap.get(func.address);
    if (className) {
      targetFile = className;
    } else if (func.namespace) {
      // Use namespace as file name
      targetFile = func.namespace;
    } else {
      // Global functions go to main file
      targetFile = '__global__';
    }

    if (!organization.has(targetFile)) {
      organization.set(targetFile, []);
    }
    organization.get(targetFile)!.push(func.address);
  }

  return organization;
}
