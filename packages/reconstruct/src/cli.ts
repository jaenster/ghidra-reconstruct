#!/usr/bin/env node
/**
 * CLI for source reconstruction from Ghidra projects
 */

import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { reconstruct, analyze } from './index.js';
import { loadProjectConfig } from './config/loader.js';
import type { ReconstructOptions } from './types.js';
import { defaultOptions } from './types.js';

const program = new Command();

program
  .name('ghidra-reconstruct')
  .description('Reconstruct source code from Ghidra projects')
  .version('1.0.0');

// Analyze command
program
  .command('analyze <project>')
  .description('Analyze a Ghidra project and generate a report')
  .option('-o, --output <file>', 'Output file for analysis report (JSON)')
  .option('-d, --daemon <url>', 'Daemon URL', 'http://localhost:3000')
  .option('-v, --verbose', 'Verbose output')
  .action(async (projectPath: string, options: {
    output?: string;
    daemon: string;
    verbose?: boolean;
  }) => {
    try {
      console.log(`Analyzing project: ${projectPath}`);

      const result = await analyze(projectPath, {
        daemonUrl: options.daemon,
        onProgress: options.verbose
          ? (phase, current, total) => {
              console.log(`  [${phase}] ${current}/${total}`);
            }
          : undefined,
      });

      if (options.output) {
        await fs.writeFile(options.output, JSON.stringify(result, null, 2));
        console.log(`Analysis written to: ${options.output}`);
      } else {
        // Print summary to console
        console.log('\n=== Analysis Summary ===');
        console.log(`Functions: ${result.stats.functionsProcessed}`);
        console.log(`Classes detected: ${result.stats.classesDetected}`);
        console.log(`Data types: ${result.stats.dataTypesExtracted}`);
        console.log(`Globals: ${result.stats.globalsExtracted}`);
        console.log(`Strings: ${result.stats.stringsExtracted}`);

        if (result.classes.length > 0) {
          console.log('\nDetected classes:');
          for (const cls of result.classes.slice(0, 10)) {
            console.log(`  - ${cls.name} (${cls.methods.length} methods)`);
          }
          if (result.classes.length > 10) {
            console.log(`  ... and ${result.classes.length - 10} more`);
          }
        }

        if (result.scopingAnalysis.filter(s => s.shouldBeStatic).length > 0) {
          console.log('\nGlobals that could be static:');
          const staticGlobals = result.scopingAnalysis.filter(s => s.shouldBeStatic);
          for (const g of staticGlobals.slice(0, 5)) {
            console.log(`  - ${g.globalName} -> ${g.suggestedLocation}`);
          }
          if (staticGlobals.length > 5) {
            console.log(`  ... and ${staticGlobals.length - 5} more`);
          }
        }
      }

      console.log('\nAnalysis complete.');
    } catch (error) {
      console.error('Analysis failed:', error);
      process.exit(1);
    }
  });

// Export command
program
  .command('export <project>')
  .description('Export reconstructed source code from a Ghidra project')
  .option('-o, --output <dir>', 'Output directory', defaultOptions.outputDir)
  .option('-f, --format <type>', 'Output format (cpp|c)', defaultOptions.format)
  .option('--organization <type>', 'File organization (namespace|flat|module)', defaultOptions.organization)
  .option('--generate-cmake', 'Generate CMakeLists.txt', defaultOptions.generateCMake)
  .option('--no-generate-cmake', 'Do not generate CMakeLists.txt')
  .option('--source-map', 'Generate source map files', defaultOptions.generateSourceMaps)
  .option('--no-source-map', 'Do not generate source map files')
  .option('--transform-preset <preset>', 'Transform preset (quick|full)', defaultOptions.transformPreset)
  .option('--include-address-comments', 'Include address comments in code')
  .option('--no-static-promotion', 'Disable static promotion for globals')
  .option('--project-name <name>', 'Project name for CMakeLists.txt')
  .option('--project-dir <dir>', 'Directory containing project.json (defaults to output dir)')
  .option('-d, --daemon <url>', 'Daemon URL', 'http://localhost:3000')
  .option('-v, --verbose', 'Verbose output')
  .action(async (projectPath: string, options: {
    output: string;
    format: 'cpp' | 'c';
    organization: 'namespace' | 'flat' | 'module';
    generateCmake: boolean;
    sourceMap: boolean;
    transformPreset: 'quick' | 'full';
    includeAddressComments?: boolean;
    staticPromotion?: boolean;
    projectName?: string;
    projectDir?: string;
    daemon: string;
    verbose?: boolean;
  }) => {
    try {
      console.log(`Exporting project: ${projectPath}`);
      console.log(`Output directory: ${options.output}`);

      // Load project config from project dir (or output dir)
      const configDir = options.projectDir ?? options.output;
      const projectConfig = await loadProjectConfig(configDir);
      if (projectConfig) {
        const mc = projectConfig.methodConversions?.length ?? 0;
        const ov = projectConfig.overrides?.length ?? 0;
        const lb = projectConfig.libraries?.length ?? 0;
        console.log(`Project config: loaded (${ov} overrides, ${lb} libraries, ${mc} method conversions)`);
      }

      const reconstructOptions: ReconstructOptions = {
        outputDir: options.output,
        projectDir: options.projectDir,
        format: options.format,
        organization: options.organization,
        generateCMake: options.generateCmake,
        generateSourceMaps: options.sourceMap,
        transformPreset: options.transformPreset as 'quick' | 'full' | 'custom',
        includeAddressComments: options.includeAddressComments || false,
        promoteStaticGlobals: options.staticPromotion !== false,
        projectName: options.projectName,
        projectConfig: projectConfig ?? undefined,
      };

      const result = await reconstruct(projectPath, reconstructOptions, {
        daemonUrl: options.daemon,
        onProgress: options.verbose
          ? (phase, current, total) => {
              process.stdout.write(`\r  [${phase}] ${current}/${total}    `);
            }
          : undefined,
      });

      if (options.verbose) {
        console.log(''); // New line after progress
      }

      if (result.success) {
        console.log('\n=== Export Summary ===');
        console.log(`Files written: ${result.filesWritten.length}`);
        console.log(`Functions processed: ${result.stats.functionsProcessed}`);
        console.log(`Classes detected: ${result.stats.classesDetected}`);
        console.log(`Time: ${result.stats.timeMs}ms`);

        if (result.warnings.length > 0) {
          console.log('\nWarnings:');
          for (const warning of result.warnings.slice(0, 5)) {
            console.log(`  - ${warning}`);
          }
          if (result.warnings.length > 5) {
            console.log(`  ... and ${result.warnings.length - 5} more`);
          }
        }

        console.log(`\nOutput written to: ${result.outputDir}`);

        // Print build instructions
        if (reconstructOptions.generateCMake) {
          console.log('\nTo build:');
          console.log(`  cd ${result.outputDir}`);
          console.log('  cmake -B build');
          console.log('  cmake --build build');
        }
      } else {
        console.error('\nExport failed:');
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
    } catch (error) {
      console.error('Export failed:', error);
      process.exit(1);
    }
  });

// Info command - show what would be extracted
program
  .command('info <project>')
  .description('Show information about a Ghidra project')
  .option('-d, --daemon <url>', 'Daemon URL', 'http://localhost:3000')
  .action(async (projectPath: string, options: { daemon: string }) => {
    try {
      // This is a lightweight version that just gets basic info
      console.log(`Getting info for: ${projectPath}`);

      const { createConnection, closeConnection } = await import('./connection.js');
      const connection = await createConnection(projectPath, options.daemon);

      try {
        const info = await connection.sendCommand<{
          name: string;
          path: string;
          format: string;
          languageId: string;
          imageBase: string;
        }>('get_program_info');

        console.log('\n=== Program Info ===');
        console.log(`Name: ${info.name}`);
        console.log(`Path: ${info.path}`);
        console.log(`Format: ${info.format}`);
        console.log(`Language: ${info.languageId}`);
        console.log(`Image Base: ${info.imageBase}`);

        // Get function count
        const funcs = await connection.sendCommand<{ total: number }>('list_functions', { limit: 1 });
        console.log(`Functions: ${funcs.total}`);

        // Get namespace count
        const namespaces = await connection.sendCommand<{ total: number }>('list_namespaces', { limit: 1 });
        console.log(`Namespaces: ${namespaces.total}`);

        // Get string count
        const strings = await connection.sendCommand<{ total: number }>('list_strings', { limit: 1 });
        console.log(`Strings: ${strings.total}`);
      } finally {
        await closeConnection(connection);
      }
    } catch (error) {
      console.error('Failed to get info:', error);
      process.exit(1);
    }
  });

program.parse();
