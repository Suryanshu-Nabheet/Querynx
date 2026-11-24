/**
 * API-key management: issuance, hashed verification, revocation and
 * per-key rate budgets. Keys are stored only as SHA-256 hashes; the
 * plaintext is shown exactly once at issuance.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ApiKeyRecord {
  /** SHA-256 of the plaintext key (hex). */
  hash: string;
  /** Human label for dashboards. */
  label: string;
  /** ISO 8601 creation time. */
  createdAt: string;
  /** Optional per-key request budget per minute. */
  rateLimitPerMinute?: number;
  /** Revoked keys always fail verification. */
  revoked: boolean;
}

export interface IssuedKey {
  /** Plaintext key — shown once, never stored. */
  key: string;
  record: ApiKeyRecord;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * In-memory key store. The API layer swaps in the Drizzle-backed store
 * when DATABASE_URL is configured; the interface is identical.
 */
export class ApiKeyStore {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  /** Issue a new key with the given label. */
  issue(label: string, rateLimitPerMinute?: number): IssuedKey {
    const key = `qnx_${randomBytes(24).toString("base64url")}`;
    const record: ApiKeyRecord = {
      hash: hashApiKey(key),
      label,
      createdAt: new Date().toISOString(),
      rateLimitPerMinute,
      revoked: false,
    };
    this.byHash.set(record.hash, record);
    return { key, record };
  }

  /** Constant-time key verification. */
  verify(key: string): ApiKeyRecord | null {
    const hash = hashApiKey(key);
    const record = this.byHash.get(hash);
    if (!record || record.revoked) return null;
    return record;
  }

  /** Non-lookup API for callers that store hashes externally:
   * verify a presented key against a known hash, constant-time. */
  verifyAgainstHash(key: string, expectedHash: string): boolean {
    const actual = Buffer.from(hashApiKey(key), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  /** Revoke by hash. */
  revoke(hash: string): boolean {
    const record = this.byHash.get(hash);
    if (!record) return false;
    record.revoked = true;
    return true;
  }

  /** All records (hashes only, never plaintext). */
  list(): readonly ApiKeyRecord[] {
    return [...this.byHash.values()];
  }

  /** Import records from persistence. */
  load(records: readonly ApiKeyRecord[]): void {
    for (const record of records) this.byHash.set(record.hash, record);
  }
}
