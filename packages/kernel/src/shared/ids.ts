import { invalidArgument } from "./errors.ts";
import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";

export type IdPrefix = "space" | "group" | "membership" | "event" | "outbox";
export type DomainId = string;

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
