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

export function snapshotJsonValue(value: unknown): JsonValue {
  const path: Array<string | number> = [];
  const ancestors = new WeakSet<object>();
  const formatPath = () => {
    let formatted = "$";
    for (const segment of path)
      formatted += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
    return formatted;
  };
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError(`${formatPath()} is cyclic`);
      ancestors.add(item);
      const snapshot = new Array<JsonValue>(item.length);
      for (let index = 0; index < item.length; index += 1) {
        path.push(index);
        snapshot[index] = visit(item[index]);
        path.pop();
      }
      ancestors.delete(item);
      return snapshot;
    }
    if (
      typeof item === "object" &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      if (ancestors.has(item)) throw new TypeError(`${formatPath()} is cyclic`);
      ancestors.add(item);
      const snapshot: Record<string, JsonValue> = {};
      for (const key of Object.keys(item)) {
        path.push(key);
        const value = (item as Record<string, unknown>)[key];
        if (value === undefined)
          throw new TypeError(`${formatPath()} is undefined`);
        const itemSnapshot = visit(value);
        path.pop();
        if (key === "__proto__")
          Object.defineProperty(snapshot, key, {
            value: itemSnapshot,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else snapshot[key] = itemSnapshot;
      }
      ancestors.delete(item);
      return snapshot;
    }
    throw new TypeError(`${formatPath()} is not JSON-safe`);
  };
  return visit(value);
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
