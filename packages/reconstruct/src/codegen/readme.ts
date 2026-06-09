/**
 * README.md generation
 *
 * Generates a README file with project information and build instructions
 */

import type { ReconstructedProject, ReconstructOptions, ProgramInfo } from '../types.js';

/**
 * Generate README.md content
 */
export function generateReadme(
  project: ReconstructedProject,
  options: ReconstructOptions
): string {
  const projectName = options.projectName || project.name || 'Reconstructed';
  const lines: string[] = [];

  // Title
  lines.push(`# ${projectName}`);
  lines.push('');
  lines.push('Reconstructed source code from binary analysis using [ghidra-mcp](https://github.com/anthropics/ghidra-mcp).');
  lines.push('');

  // Binary Information
  if (project.programInfo) {
    lines.push('## Original Binary Information');
    lines.push('');
    lines.push('| Property | Value |');
    lines.push('|----------|-------|');
    lines.push(`| Name | \`${project.programInfo.name}\` |`);
    lines.push(`| Format | ${project.programInfo.format} |`);
    lines.push(`| Architecture | ${project.programInfo.architecture} |`);
    lines.push(`| Language ID | ${project.programInfo.languageId} |`);
    lines.push(`| Image Base | \`${project.programInfo.imageBase}\` |`);
    lines.push(`| Endianness | ${project.programInfo.endianness} |`);
    lines.push(`| Pointer Size | ${project.programInfo.pointerSize} bytes |`);
    if (project.programInfo.compiler) {
      lines.push(`| Compiler | ${project.programInfo.compiler} |`);
    }
    lines.push('');
  }

  // Statistics
  lines.push('## Project Statistics');
  lines.push('');
  const sourceFiles = Array.from(project.files.values()).filter(f => f.type === 'implementation');
  const headerFiles = Array.from(project.files.values()).filter(f => f.type === 'header');
  const totalFunctions = sourceFiles.reduce((sum, f) => sum + f.functions.length, 0);

  lines.push(`- **Source Files:** ${sourceFiles.length}`);
  lines.push(`- **Header Files:** ${headerFiles.length}`);
  lines.push(`- **Functions:** ${totalFunctions}`);
  lines.push(`- **Classes Detected:** ${project.classes.length}`);
  lines.push(`- **Data Types:** ${project.dataTypes.length}`);
  lines.push(`- **Global Variables:** ${project.globals.length}`);
  lines.push(`- **Namespaces:** ${project.namespaces.length}`);
  lines.push('');

  // Build Instructions
  lines.push('## Building');
  lines.push('');
  lines.push('### Using CMake');
  lines.push('');
  lines.push('```bash');
  lines.push('mkdir build && cd build');
  lines.push('cmake ..');
  lines.push('cmake --build .');
  lines.push('```');
  lines.push('');

  // Project Structure
  lines.push('## Project Structure');
  lines.push('');
  lines.push('```');
  const dirs = new Set<string>();
  for (const [path] of project.files) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  const sortedDirs = Array.from(dirs).sort();
  for (const dir of sortedDirs.slice(0, 20)) { // Limit to first 20
    const depth = dir.split('/').length - 1;
    const indent = '  '.repeat(depth);
    const name = dir.split('/').pop();
    lines.push(`${indent}${name}/`);
  }
  if (sortedDirs.length > 20) {
    lines.push(`  ... and ${sortedDirs.length - 20} more directories`);
  }
  lines.push('```');
  lines.push('');

  // Classes
  if (project.classes.length > 0) {
    lines.push('## Detected Classes');
    lines.push('');
    for (const cls of project.classes.slice(0, 20)) {
      const methodCount = cls.methods.length;
      const fieldCount = cls.fields.length;
      lines.push(`- **${cls.name}** - ${methodCount} methods, ${fieldCount} fields`);
    }
    if (project.classes.length > 20) {
      lines.push(`- ... and ${project.classes.length - 20} more classes`);
    }
    lines.push('');
  }

  // Notes
  lines.push('## Notes');
  lines.push('');
  lines.push('This code was automatically reconstructed from binary analysis and may:');
  lines.push('');
  lines.push('- Contain decompilation artifacts and generated variable names');
  lines.push('- Have missing or incorrect type information');
  lines.push('- Include unresolved external references');
  lines.push('- Require manual cleanup for compilation');
  lines.push('');
  lines.push('The source maps (`.cpp.map` files) contain address mappings back to the original binary.');
  lines.push('');

  // Generation timestamp
  lines.push('---');
  lines.push('');
  lines.push(`*Generated: ${new Date().toISOString()}*`);

  return lines.join('\n');
}
