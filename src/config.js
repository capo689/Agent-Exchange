const DEFAULT_PORT = 8787;
const DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_READ_MAX_REQUESTS = 300;
const DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS = 120;
const DEFAULT_RATE_LIMIT_AUTH_MAX_REQUESTS = 30;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function projectRefFromUrl(url) {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.replace('.supabase.co', '') : '';
  } catch {
    return '';
  }
}

function databaseConnectionInfo(databaseUrl) {
  if (!databaseUrl) {
    return {
      host: '',
      port: '',
      user: '',
      database: '',
      parseable: false
    };
  }

  try {
    const parsed = new URL(databaseUrl);
    return {
      host: parsed.hostname,
      port: parsed.port,
      user: decodeURIComponent(parsed.username),
      database: parsed.pathname.replace(/^\//, ''),
      parseable: true
    };
  } catch {
    return {
      host: '',
      port: '',
      user: '',
      database: '',
      parseable: false
    };
  }
}

export function getConfig(env = process.env) {
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const projectRef = env.SUPABASE_PROJECT_REF ?? projectRefFromUrl(supabaseUrl);
  const supabaseJwksUrl =
    env.SUPABASE_JWKS_URL ??
    (projectRef ? `https://${projectRef}.supabase.co/auth/v1/.well-known/jwks.json` : '');
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? '';
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const databaseUrl = env.DATABASE_URL ?? '';
  const dataDir = env.DATA_DIR ?? '';

  return {
    port: parsePositiveInteger(env.PORT, DEFAULT_PORT),
    dataDir,
    maxJsonBodyBytes: parsePositiveInteger(env.MAX_JSON_BODY_BYTES, DEFAULT_MAX_JSON_BODY_BYTES),
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED !== 'false',
      windowMs: parsePositiveInteger(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
      readMaxRequests: parsePositiveInteger(env.RATE_LIMIT_READ_MAX_REQUESTS, DEFAULT_RATE_LIMIT_READ_MAX_REQUESTS),
      writeMaxRequests: parsePositiveInteger(env.RATE_LIMIT_WRITE_MAX_REQUESTS, DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS),
      authMaxRequests: parsePositiveInteger(env.RATE_LIMIT_AUTH_MAX_REQUESTS, DEFAULT_RATE_LIMIT_AUTH_MAX_REQUESTS)
    },
    databaseUrl,
    database: databaseConnectionInfo(databaseUrl),
    storageBackend: databaseUrl ? 'postgres' : dataDir ? 'json' : 'memory',
    supabase: {
      url: supabaseUrl,
      projectRef,
      jwksUrl: supabaseJwksUrl,
      publishableKey: supabasePublishableKey,
      secretKey: supabaseSecretKey
    }
  };
}

export function getSafeRuntimeStatus(env = process.env) {
  const config = getConfig(env);
  return {
    storageBackend: config.storageBackend,
    databaseConfigured: Boolean(config.databaseUrl),
    databaseConnection: config.databaseUrl
      ? {
          host: config.database.host,
          port: config.database.port,
          user: config.database.user,
          database: config.database.database,
          parseable: config.database.parseable
        }
      : null,
    adminConfigured: Boolean(env.ADMIN_TOKEN),
    supabaseConfigured: Boolean(
      config.supabase.url &&
        config.supabase.projectRef &&
        config.supabase.publishableKey &&
        config.supabase.secretKey
    ),
    supabaseJwksConfigured: Boolean(config.supabase.jwksUrl),
    maxJsonBodyBytes: config.maxJsonBodyBytes,
    rateLimit: config.rateLimit
  };
}
