import { z } from "zod";

const logLevels = ["debug", "info", "warn", "error"] as const;
const envModes = ["development", "production", "test"] as const;

const configSchema = z.object({
  env: z.enum(envModes),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  lan: z.boolean(),
  dbPath: z.string().min(1),
  logLevel: z.enum(logLevels),
  webHost: z.string().min(1),
  webPort: z.number().int().min(1).max(65535),
  apiUrl: z.string().url(),
  version: z.string().min(1)
});

export type AppConfig = z.infer<typeof configSchema>;
export type LogLevel = (typeof logLevels)[number];
export type EnvMode = (typeof envModes)[number];

export interface PublicConfig {
  env: EnvMode;
  host: string;
  port: number;
  lan: boolean;
  logLevel: LogLevel;
  webHost: string;
  webPort: number;
  apiUrl: string;
  version: string;
  dbPathConfigured: boolean;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function parsePort(value: string | undefined, fallback: number, path: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError([{ path, message: "must be an integer between 1 and 65535" }]);
  }
  return n;
}

function parseEnum<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
  path: string
): T[number] {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new ConfigError([{ path, message: `must be one of: ${allowed.join(", ")}` }]);
}

function parseBoolean(value: string | undefined, fallback: boolean, path: string): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new ConfigError([{ path, message: "must be a boolean (true/false/1/0/yes/no/on/off)" }]);
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  version?: string;
}

let cached: AppConfig | null = null;

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const source = options.env ?? process.env;
  const version = options.version ?? source.MARKETHUB_VERSION ?? "0.1.0";

  const env = parseEnum(source.MARKETHUB_ENV ?? source.NODE_ENV, envModes, "development", "MARKETHUB_ENV/NODE_ENV");
  const lan = parseBoolean(source.MARKETHUB_LAN, false, "MARKETHUB_LAN");

  const hostExplicit = source.MARKETHUB_HOST;
  const host = hostExplicit && hostExplicit !== "" ? hostExplicit : lan ? "0.0.0.0" : "127.0.0.1";

  const port = parsePort(source.MARKETHUB_PORT ?? source.PORT, 3001, "MARKETHUB_PORT/PORT");
  const webPort = parsePort(source.MARKETHUB_WEB_PORT, 5173, "MARKETHUB_WEB_PORT");
  const webHostExplicit = source.MARKETHUB_WEB_HOST;
  const webHost = webHostExplicit && webHostExplicit !== "" ? webHostExplicit : lan ? "0.0.0.0" : "127.0.0.1";

  const dbPath = source.MARKETHUB_DB_PATH && source.MARKETHUB_DB_PATH !== "" ? source.MARKETHUB_DB_PATH : "./data/markethub.sqlite";
  const logLevel = parseEnum(source.MARKETHUB_LOG_LEVEL, logLevels, "info", "MARKETHUB_LOG_LEVEL");

  const defaultApiUrl = `http://localhost:${port}`;
  const apiUrl = source.MARKETHUB_API_URL && source.MARKETHUB_API_URL !== "" ? source.MARKETHUB_API_URL : defaultApiUrl;

  const candidate = { env, host, port, lan, dbPath, logLevel, webHost, webPort, apiUrl, version };
  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues: ConfigIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "config",
      message: i.message
    }));
    throw new ConfigError(issues);
  }

  cached = parsed.data;
  return parsed.data;
}

export function getConfig(): AppConfig {
  if (!cached) return loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

function sanitizeApiUrlForLog(apiUrl: string): string {
  try {
    const u = new URL(apiUrl);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    lan: config.lan,
    logLevel: config.logLevel,
    webHost: config.webHost,
    webPort: config.webPort,
    apiUrl: sanitizeApiUrlForLog(config.apiUrl),
    version: config.version,
    dbPathConfigured: config.dbPath.length > 0
  };
}

export function redactConfigForLog(config: AppConfig): Record<string, unknown> {
  // Intentionally excludes raw dbPath and strips credentials from apiUrl.
  return { ...toPublicConfig(config) };
}
