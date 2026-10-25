// SECURITY DRY: the secret regex set (SECRET_KEY_PATTERN / SECRET_KEY_SUBSTRINGS
// / BEARER_TOKEN_PATTERN / AUTH_HEADER_PATTERN / URL_CREDENTIAL_PATTERN /
// ASSIGNMENT_SECRET_PATTERN) and the redactString / isSecretKey primitives live
// in the observability redaction module, which is the canonical (superset)
// implementation. This module re-exports those primitives and only adds the
// `unknown`-typed walkers (`redactUnknown` / `redactRecord`) that handle Error
// instances, so a fix to any pattern is applied in exactly one place.
import {
  isSecretKey,
  redactString,
  REDACTED_VALUE,
} from "takosumi-contract/redaction";
import { readErrorDataString } from "./errors.ts";

export { REDACTED_VALUE, redactString };

// These walkers feed both logs and durable Activity metadata. Inspect only
// own data properties: calling an accessor or arbitrary toJSON can execute
// untrusted code or reveal values that were not previously enumerable.
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ENTRIES = 1_024;
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const UNREADABLE = "[Unreadable]";

interface RedactionBudget {
  nodes: number;
  readonly ancestors: Set<object>;
}

export function redactUnknown(value: unknown): unknown {
  return redactWithin(value, { nodes: 0, ancestors: new Set() }, 0);
}

export function redactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactUnknown(value);
  return redacted !== null &&
      typeof redacted === "object" &&
      !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : inertToJson({ value: redacted });
}

function inertToJson<T extends object>(value: T): T {
  // JSON.stringify otherwise consults Object.prototype/Array.prototype and
  // can run an inherited toJSON after this function has redacted the values.
  Object.defineProperty(value, "toJSON", {
    value: undefined,
    configurable: true,
  });
  return value;
}

function redactWithin(
  value: unknown,
  budget: RedactionBudget,
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return TRUNCATED;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (budget.ancestors.has(value)) return CIRCULAR;

  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) return redactArray(value, budget, depth);
    if (value instanceof Error) {
      const name = readErrorDataString(value, "name");
      const message = readErrorDataString(value, "message");
      const stack = readErrorDataString(value, "stack");
      if (name === undefined || message === undefined) {
        return UNREADABLE;
      }
      return inertToJson({
        name: redactString(name),
        message: redactString(message),
        stack: stack === undefined ? undefined : redactString(stack),
      });
    }
    if (value instanceof Date) {
      return Number.isNaN(Date.prototype.getTime.call(value))
        ? "[Invalid Date]"
        : Date.prototype.toISOString.call(value);
    }
    // URL.href can contain username-only credentials and arbitrary query
    // tokens that string-pattern redaction cannot prove safe.
    if (value instanceof URL) return "[URL]";
    return redactOwnData(value, budget, depth);
  } catch {
    return UNREADABLE;
  } finally {
    budget.ancestors.delete(value);
  }
}

function redactArray(
  value: unknown[],
  budget: RedactionBudget,
  depth: number,
): unknown[] {
  const out: unknown[] = inertToJson([]);
  const limit = Math.min(value.length, MAX_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    if (budget.nodes >= MAX_NODES) break;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    out.push(descriptor === undefined
      ? null
      : "value" in descriptor
      ? redactWithin(descriptor.value, budget, depth + 1)
      : UNREADABLE);
  }
  if (limit < value.length || budget.nodes >= MAX_NODES) out.push(TRUNCATED);
  return out;
}

function redactOwnData(
  value: object,
  budget: RedactionBudget,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = inertToJson({});
  // Object.keys asks a Proxy for the descriptor of every key before we can
  // apply the entry budget. Inspect only the first bounded own-key slots.
  // Reflect.ownKeys itself remains one indivisible user-defined Proxy trap.
  const keys = Reflect.ownKeys(value);
  const limit = Math.min(keys.length, MAX_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    if (budget.nodes >= MAX_NODES) break;
    const key = keys[index]!;
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) continue;
    const redacted = isSecretKey(key)
      ? REDACTED_VALUE
      : descriptor === undefined || !("value" in descriptor)
      ? UNREADABLE
      : redactWithin(descriptor.value, budget, depth + 1);
    // Assignment to `__proto__` would mutate the output prototype. Define
    // each key as an own data property instead.
    Object.defineProperty(out, key, {
      value: redacted,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (limit < keys.length || budget.nodes >= MAX_NODES) {
    Object.defineProperty(out, TRUNCATED, {
      value: TRUNCATED,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
