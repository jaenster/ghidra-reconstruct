/**
 * Platform utilities for cross-platform Ghidra MCP operation
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Platform Detection
// =============================================================================

export type Platform = 'windows' | 'macos' | 'linux';

export function getPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

// =============================================================================
// Ghidra Paths
// =============================================================================

export interface GhidraPaths {
  ghidraHome: string;
  analyzeHeadless: string;
  launchProperties: string;
  supportDir: string;
  javaHome?: string;
}

export function getGhidraHome(): string {
  const ghidraHome = process.env.GHIDRA_HOME;
  if (ghidraHome && fs.existsSync(ghidraHome)) {
    return ghidraHome;
  }

  // Try common installation locations
  const platform = getPlatform();
  const candidates = getGhidraHomeCandidates(platform);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Verify it's actually Ghidra
      const analyzeScript = path.join(candidate, 'support', getAnalyzeHeadlessName());
      if (fs.existsSync(analyzeScript)) {
        return candidate;
      }
    }
  }

  throw new Error(
    'Ghidra installation not found. Please set GHIDRA_HOME environment variable ' +
    'to point to your Ghidra installation directory.'
  );
}

function getGhidraHomeCandidates(platform: Platform): string[] {
  const homeDir = os.homedir();

  switch (platform) {
    case 'macos':
      return [
        '/Applications/ghidra',
        '/Applications/Ghidra',
        '/usr/local/ghidra',
        path.join(homeDir, 'ghidra'),
        path.join(homeDir, 'Applications', 'ghidra'),
        // Common versioned paths
        ...findGhidraVersionedDirs('/Applications'),
        ...findGhidraVersionedDirs(path.join(homeDir, 'Applications')),
      ];

    case 'linux':
      return [
        '/opt/ghidra',
        '/usr/local/ghidra',
        '/usr/share/ghidra',
        path.join(homeDir, 'ghidra'),
        path.join(homeDir, '.local', 'share', 'ghidra'),
        ...findGhidraVersionedDirs('/opt'),
        ...findGhidraVersionedDirs(path.join(homeDir, '.local', 'share')),
      ];

    case 'windows':
      return [
        'C:\\ghidra',
        'C:\\Program Files\\ghidra',
        'C:\\Program Files (x86)\\ghidra',
        path.join(homeDir, 'ghidra'),
        ...findGhidraVersionedDirs('C:\\'),
        ...findGhidraVersionedDirs('C:\\Program Files'),
      ];
  }
}

function findGhidraVersionedDirs(parentDir: string): string[] {
  const results: string[] = [];
  try {
    if (fs.existsSync(parentDir)) {
      const entries = fs.readdirSync(parentDir);
      for (const entry of entries) {
        if (entry.toLowerCase().startsWith('ghidra')) {
          results.push(path.join(parentDir, entry));
        }
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results;
}

function getAnalyzeHeadlessName(): string {
  return isWindows() ? 'analyzeHeadless.bat' : 'analyzeHeadless';
}

export function getGhidraPaths(): GhidraPaths {
  const ghidraHome = getGhidraHome();
  const analyzeHeadlessName = getAnalyzeHeadlessName();

  return {
    ghidraHome,
    analyzeHeadless: path.join(ghidraHome, 'support', analyzeHeadlessName),
    launchProperties: path.join(ghidraHome, 'support', 'launch.properties'),
    supportDir: path.join(ghidraHome, 'support'),
    javaHome: process.env.JAVA_HOME,
  };
}

// =============================================================================
// Java Paths
// =============================================================================

export function getJavaExecutable(): string {
  const javaHome = process.env.JAVA_HOME;

  if (javaHome) {
    const javaPath = isWindows()
      ? path.join(javaHome, 'bin', 'java.exe')
      : path.join(javaHome, 'bin', 'java');

    if (fs.existsSync(javaPath)) {
      return javaPath;
    }
  }

  // Fall back to system java
  return 'java';
}

export function validateJavaVersion(): boolean {
  // This would actually run java -version and check
  // For now, just return true
  return true;
}

// =============================================================================
// Application Data Paths
// =============================================================================

export interface AppPaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  tempDir: string;
  pidFile: string;
  databaseFile: string;
}

export function getAppPaths(): AppPaths {
  const platform = getPlatform();
  const homeDir = os.homedir();
  const appName = 'ghidra-mcp';

  let configDir: string;
  let dataDir: string;

  switch (platform) {
    case 'macos':
      configDir = path.join(homeDir, 'Library', 'Application Support', appName);
      dataDir = configDir;
      break;

    case 'linux':
      configDir = path.join(homeDir, '.config', appName);
      dataDir = path.join(homeDir, '.local', 'share', appName);
      break;

    case 'windows':
      const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      configDir = path.join(appData, appName);
      dataDir = configDir;
      break;
  }

  const logsDir = path.join(dataDir, 'logs');
  const tempDir = path.join(dataDir, 'temp');

  return {
    configDir,
    dataDir,
    logsDir,
    tempDir,
    pidFile: path.join(dataDir, 'daemon.pid'),
    databaseFile: path.join(dataDir, 'state.db'),
  };
}

export function ensureAppDirs(): void {
  const paths = getAppPaths();
  for (const dir of [paths.configDir, paths.dataDir, paths.logsDir, paths.tempDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// =============================================================================
// Project Paths (for Ghidra projects)
// =============================================================================

export function getProjectsDir(): string {
  const paths = getAppPaths();
  const projectsDir = path.join(paths.dataDir, 'projects');
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  return projectsDir;
}

export function getProjectPath(sessionId: string): string {
  return path.join(getProjectsDir(), sessionId);
}

// =============================================================================
// Ghidra Worker JAR
// =============================================================================

export function getWorkerJarPath(): string {
  // Try to find the JAR file with version number or without
  const jarNames = ['ghidra-worker.jar', 'ghidra-worker-1.0.0.jar'];

  // First, check if we're in development (JAR is in ghidra-worker/build/libs)
  for (const jarName of jarNames) {
    const devPath = path.join(process.cwd(), 'ghidra-worker', 'build', 'libs', jarName);
    if (fs.existsSync(devPath)) {
      return devPath;
    }
  }

  // Check relative to this module
  for (const jarName of jarNames) {
    const modulePath = path.join(__dirname, '..', '..', '..', 'ghidra-worker', 'build', 'libs', jarName);
    if (fs.existsSync(modulePath)) {
      return modulePath;
    }
  }

  // Check in node_modules (when installed as dependency)
  for (const jarName of jarNames) {
    const installedPath = path.join(__dirname, '..', '..', '..', '..', 'ghidra-worker', jarName);
    if (fs.existsSync(installedPath)) {
      return installedPath;
    }
  }

  throw new Error(
    'Ghidra worker JAR not found. Please build it with: cd ghidra-worker && ./gradlew build'
  );
}

// =============================================================================
// Port Management
// =============================================================================

export const DEFAULT_DAEMON_PORT = 8432;
export const DEFAULT_WORKER_PORT_RANGE_START = 8500;
export const DEFAULT_WORKER_PORT_RANGE_END = 8600;

export function getDaemonPort(): number {
  const portEnv = process.env.GHIDRA_MCP_PORT;
  if (portEnv) {
    const port = parseInt(portEnv, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }
  return DEFAULT_DAEMON_PORT;
}

// =============================================================================
// Utility Functions
// =============================================================================

export function normalizeWindowsPath(p: string): string {
  if (isWindows()) {
    // Convert forward slashes to backslashes on Windows
    return p.replace(/\//g, '\\');
  }
  return p;
}

export function escapePath(p: string): string {
  if (isWindows()) {
    // On Windows, wrap in quotes if contains spaces
    if (p.includes(' ')) {
      return `"${p}"`;
    }
    return p;
  }
  // On Unix, escape spaces
  return p.replace(/ /g, '\\ ');
}

export function getMemoryLimit(): string {
  // Default to 4GB for Ghidra, can be overridden
  return process.env.GHIDRA_MCP_MEMORY || '4g';
}
