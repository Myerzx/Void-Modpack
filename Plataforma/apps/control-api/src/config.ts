export interface ControlApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly cookieSecure: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean configuration value: ${value}`);
}

export function readControlApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlApiConfig {
  const databaseUrl = environment['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required.');
  }
  const port = Number(environment['VOIDFALL_CONTROL_API_PORT'] ?? '3100');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VOIDFALL_CONTROL_API_PORT must be a valid TCP port.');
  }
  const isProduction = environment['NODE_ENV'] === 'production';
  const cookieSecure = parseBoolean(environment['VOIDFALL_COOKIE_SECURE'], true);
  if (isProduction && !cookieSecure) {
    throw new Error('Secure session cookies cannot be disabled in production.');
  }
  return {
    databaseUrl,
    host: environment['VOIDFALL_CONTROL_API_HOST'] ?? '127.0.0.1',
    port,
    cookieSecure,
  };
}
