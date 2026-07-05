import {
  X402_BASE_SEPOLIA_NETWORK,
  x402AssetForNetwork
} from './payments.js';

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_READ_MAX_REQUESTS = 300;
const DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS = 120;
const DEFAULT_RATE_LIMIT_AUTH_MAX_REQUESTS = 30;
const DEFAULT_X402_FACILITATOR_URL = 'https://x402.org/facilitator';
const CDP_X402_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

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
  const paymentProvider = env.PAYMENT_PROVIDER ?? 'sandbox';
  const x402Network = env.X402_NETWORK ?? X402_BASE_SEPOLIA_NETWORK;
  const x402FacilitatorUrl =
    env.X402_FACILITATOR_URL ??
    (env.X402_USE_CDP_FACILITATOR === 'true' ? CDP_X402_FACILITATOR_URL : DEFAULT_X402_FACILITATOR_URL);
  const x402FacilitatorBearerToken = env.X402_FACILITATOR_BEARER_TOKEN ?? env.CDP_API_BEARER_TOKEN ?? '';
  const x402FacilitatorRequiresAuth =
    env.X402_FACILITATOR_REQUIRES_AUTH === 'true' ||
    x402FacilitatorUrl.includes('api.cdp.coinbase.com');

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
    payment: {
      provider: paymentProvider,
      sandboxWebhookConfigured: Boolean(env.PAYMENT_SANDBOX_WEBHOOK_SECRET),
      x402: {
        configured: Boolean(env.X402_PAY_TO && x402FacilitatorUrl),
        payTo: env.X402_PAY_TO ?? '',
        network: x402Network,
        asset: env.X402_ASSET ?? x402AssetForNetwork(x402Network),
        scheme: env.X402_SCHEME ?? 'exact',
        facilitatorUrl: x402FacilitatorUrl,
        facilitatorRequiresAuth: x402FacilitatorRequiresAuth,
        facilitatorBearerToken: x402FacilitatorBearerToken,
        maxTimeoutSeconds: parsePositiveInteger(env.X402_MAX_TIMEOUT_SECONDS, 60)
      }
    },
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
    payment: {
      provider: config.payment.provider,
      sandboxWebhookConfigured: config.payment.sandboxWebhookConfigured,
      x402: {
        configured: config.payment.x402.configured,
        payToConfigured: Boolean(config.payment.x402.payTo),
        network: config.payment.x402.network,
        asset: config.payment.x402.asset,
        scheme: config.payment.x402.scheme,
        facilitatorHost: config.payment.x402.facilitatorUrl
          ? databaseConnectionInfo(config.payment.x402.facilitatorUrl).host
          : '',
        facilitatorRequiresAuth: config.payment.x402.facilitatorRequiresAuth,
        facilitatorBearerConfigured: Boolean(config.payment.x402.facilitatorBearerToken),
        maxTimeoutSeconds: config.payment.x402.maxTimeoutSeconds
      }
    },
    maxJsonBodyBytes: config.maxJsonBodyBytes,
    rateLimit: config.rateLimit
  };
}
