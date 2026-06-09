/**
 * Logging types shared between daemon and workers
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

export interface LogEntry {
  timestamp: number;        // Unix timestamp in milliseconds
  level: LogLevel;
  source: 'daemon' | 'worker';
  component: string;        // e.g., 'WorkerPool', 'GhidraEngine'
  sessionId?: string;
  workerId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface LogQueryOptions {
  sessionId?: string;
  workerId?: string;
  level?: LogLevel;
  component?: string;
  since?: number;           // Unix timestamp in milliseconds
  until?: number;           // Unix timestamp in milliseconds
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
}

/**
 * Log level priority (lower = more severe)
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

/**
 * Check if a log level should be included given a minimum level
 */
export function shouldLog(entryLevel: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[entryLevel] <= LOG_LEVEL_PRIORITY[minLevel];
}
