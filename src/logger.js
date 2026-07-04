import { randomUUID } from 'node:crypto';

const levels = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

function configuredLevel() {
  return process.env.LOG_LEVEL ?? 'info';
}

function shouldLog(level) {
  return levels[level] >= (levels[configuredLevel()] ?? levels.info);
}

function serializeError(error) {
  if (!error) return undefined;

  return {
    name: error.name,
    message: error.message,
    code: error.code
  };
}

export function createRequestId() {
  return `req_${randomUUID()}`;
}

export function log(level, event, fields = {}) {
  if (!shouldLog(level)) return;

  const entry = {
    at: new Date().toISOString(),
    level,
    event,
    ...fields
  };

  if (entry.error instanceof Error) {
    entry.error = serializeError(entry.error);
  }

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

export function info(event, fields) {
  log('info', event, fields);
}

export function warn(event, fields) {
  log('warn', event, fields);
}

export function error(event, fields) {
  log('error', event, fields);
}
