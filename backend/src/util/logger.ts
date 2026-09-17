type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) {
    return;
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (extra === undefined) {
    sink(line);
    return;
  }

  // Errors print far more usefully as message + stack than as an inspected object.
  sink(line, extra instanceof Error ? `${extra.message}` : extra);
  if (extra instanceof Error && extra.stack && level === 'error') {
    sink(extra.stack);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit('debug', scope, message, extra),
    info: (message: string, extra?: unknown) => emit('info', scope, message, extra),
    warn: (message: string, extra?: unknown) => emit('warn', scope, message, extra),
    error: (message: string, extra?: unknown) => emit('error', scope, message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
