import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

export function assertJsonValue(
  value: unknown,
  path = "$",
  ancestors = new WeakSet<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
    ancestors.add(value);
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, ancestors),
    );
    ancestors.delete(value);
    return;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
    ancestors.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined)
        throw new TypeError(`${path}.${key} is undefined`);
      assertJsonValue(item, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw new TypeError(`${path} is not JSON-safe`);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

export function canonicalHash(value: JsonValue): string {
  assertJsonValue(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
