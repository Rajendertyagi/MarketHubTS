import type { LogLevel } from "@markethub/config";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

function emit(level: LogLevel, configured: LogLevel, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[configured]) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export function createLogger(level: LogLevel): Logger {
  return {
    debug: (msg, meta) => emit("debug", level, msg, meta),
    info: (msg, meta) => emit("info", level, msg, meta),
    warn: (msg, meta) => emit("warn", level, msg, meta),
    error: (msg, meta) => emit("error", level, msg, meta)
  };
}
