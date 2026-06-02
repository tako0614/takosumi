import { invalidArgument } from "./errors.ts";
import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";

export type IdPrefix = "space" | "group" | "membership" | "event" | "outbox";
export type DomainId = string;

/**
 * Canonical alias for a Takosumi Space identifier.
 *
 * Currently a plain string; kept as a named alias so that future branding
 * (opaque or nominal types) can be introduced from a single location.
 * Domain modules re-export this type to preserve the existing public surface.
 */
export type SpaceId = string;

export interface IdGenerator {
  create(prefix: IdPrefix): DomainId;
}

export const cryptoIdGenerator: IdGenerator = {
  create: (prefix: IdPrefix) => `${prefix}_${crypto.randomUUID()}`,
};

export function createId(
  prefix: IdPrefix,
  generator: IdGenerator = cryptoIdGenerator,
): DomainId {
  return generator.create(prefix);
}

export function requireNonEmptyId(
  value: string | undefined,
  fieldName: string,
): Result<string, ReturnType<typeof invalidArgument>> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return err(invalidArgument(`${fieldName} is required`, { fieldName }));
  }
  return ok(trimmed);
}
