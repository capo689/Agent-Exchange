function routeBucket(method, pathname) {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (
    pathname === '/v1/agents/register' ||
    /^\/v1\/agents\/[^/]+\/verify\/(challenge|response)$/.test(pathname)
  ) {
    return 'auth';
  }
  return 'write';
}

function clientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  return req.socket?.remoteAddress ?? 'unknown';
}

export function createRateLimiter(config, { now = () => Date.now() } = {}) {
  const buckets = new Map();

  function limitFor(bucket) {
    if (bucket === 'auth') return config.authMaxRequests;
    if (bucket === 'write') return config.writeMaxRequests;
    return config.readMaxRequests;
  }

  function check(req, pathname) {
    if (!config.enabled) return { allowed: true };

    const bucket = routeBucket(req.method, pathname);
    const limit = limitFor(bucket);
    const windowMs = config.windowMs;
    const at = now();
    const key = `${clientIp(req)}:${bucket}`;
    const current = buckets.get(key);
    const resetAt = !current || current.resetAt <= at ? at + windowMs : current.resetAt;
    const count = !current || current.resetAt <= at ? 1 : current.count + 1;
    buckets.set(key, { count, resetAt });

    const remaining = Math.max(0, limit - count);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - at) / 1000));
    const headers = {
      'retry-after': String(retryAfterSeconds),
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(Math.ceil(resetAt / 1000))
    };

    if (count > limit) {
      return {
        allowed: false,
        bucket,
        headers,
        retryAfterSeconds
      };
    }

    return { allowed: true, bucket, headers };
  }

  function cleanup() {
    const at = now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  return { check, cleanup };
}
