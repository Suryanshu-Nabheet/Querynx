/**
 * Secret redaction for logs, error messages and stored payloads.
 */

/** Common credential env var names whose values must never leak. */
const SENSITIVE_KEYS = [
  'api_key', 'apikey', 'key', 'token', 'secret', 'password', 'passwd',
  'authorization', 'auth', 'credential', 'credentials', 'bearer',
  'cookie', 'session', 'private', 'access_token', 'refresh_token',
];

/** Redact values of sensitive keys in a plain object (shallow-safe, recursive). */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lower === s || lower.includes(s)) && typeof v === 'string') {
        out[k] = v.length > 0 ? '[REDACTED]' : v;
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Redact credential-shaped substrings from free text (logs, errors). */
export function redactText(text: string): string {
  let out = text;
  // Bearer tokens.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  // Long hex/base64 runs that look like keys (>= 16 chars, word-boundary).
  out = out.replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, (m) =>
    /^(https?:\/\/|[\w.-]+\.[a-z]{2,})/i.test(m) ? m : '[REDACTED]'
  );
  // Assigned secrets in env-style dumps: KEY=value
  out = out.replace(
    /(\b[\w]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[\w]*\s*=\s*)([^\s]+)/gi,
    '$1[REDACTED]'
  );
  return out;
}

/** Known standard credential env var patterns for whole-config scanning. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = k.toUpperCase().match(/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/) && v
      ? '[REDACTED]'
      : v;
  }
  return out;
}
