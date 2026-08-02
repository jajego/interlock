import { InterlockError } from "./errors.js";
import type { InputIssue, VersionToken } from "./types.js";

/** Largest positive version representable by PostgreSQL's signed `BIGINT`. */
export const MAX_BIGINT_VERSION = 9_223_372_036_854_775_807n;

/**
 * Validates a public persistence-boundary version token. Accepted values are
 * positive canonical decimal strings within PostgreSQL's signed `BIGINT`
 * range; zero, negatives, malformed strings, and overflow are rejected.
 */
export function parseVersionToken(
  value: unknown,
):
  | { success: true; value: VersionToken }
  | { success: false; issue: InputIssue } {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    BigInt(value) > MAX_BIGINT_VERSION
  ) {
    return {
      success: false,
      issue: {
        path: ["expectedVersion"],
        code: "INVALID_VERSION_TOKEN",
        message: "Expected a positive PostgreSQL BIGINT version string.",
      },
    };
  }
  return { success: true, value: value as VersionToken };
}

/**
 * Increments a validated decimal-string version token. Incrementing
 * `MAX_BIGINT_VERSION` throws instead of wrapping.
 */
export function incrementVersion(version: VersionToken): VersionToken {
  const value = BigInt(version);
  if (value >= MAX_BIGINT_VERSION)
    throw new InterlockError(
      "INTERLOCK_VERSION_EXHAUSTED",
      "The PostgreSQL BIGINT version counter is exhausted.",
    );
  return String(value + 1n) as VersionToken;
}
