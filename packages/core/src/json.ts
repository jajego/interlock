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

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
  );
}

export function snapshotJsonValue(
  value: unknown,
  path = "$",
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
    ancestors.add(value);
    const snapshot: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1)
      snapshot.push(
        snapshotJsonValue(value[index], `${path}[${index}]`, ancestors),
      );
    ancestors.delete(value);
    return snapshot;
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
    ancestors.add(value);
    const snapshot: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined)
        throw new TypeError(`${path}.${key} is undefined`);
      const itemSnapshot = snapshotJsonValue(item, `${path}.${key}`, ancestors);
      if (key === "__proto__")
        Object.defineProperty(snapshot, key, {
          value: itemSnapshot,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else snapshot[key] = itemSnapshot;
    }
    ancestors.delete(value);
    return snapshot;
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
