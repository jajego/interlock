import type { InputIssue, VersionToken } from "./types.js";

export function parseVersionToken(
  value: unknown,
):
  | { success: true; value: VersionToken }
  | { success: false; issue: InputIssue } {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return {
      success: false,
      issue: {
        path: ["expectedVersion"],
        code: "INVALID_VERSION_TOKEN",
        message: "Expected a positive decimal version string.",
      },
    };
  }
  return { success: true, value: value as VersionToken };
}

export const incrementVersion = (version: VersionToken): VersionToken =>
  String(BigInt(version) + 1n) as VersionToken;
