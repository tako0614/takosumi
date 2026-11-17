import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";

/** Ordinary records written before authentication generations belong to generation zero. */
export async function accountAuthenticationGenerationMatches(
  store: AccountsStore,
  subject: TakosumiSubject | undefined,
  generation: number | undefined,
): Promise<boolean> {
  return authenticationGenerationMatchesSnapshot(subject ? await readOrdinaryAccountAuthenticationGeneration(store, subject) : 0, generation);
}

export function authenticationGenerationMatchesSnapshot(current: number, generation?: number): boolean {
  const expected = generation ?? 0;
  return Number.isSafeInteger(expected) && expected >= 0 && current === expected;
}

export async function readOrdinaryAccountAuthenticationGeneration(store: AccountsStore, subject: TakosumiSubject): Promise<number> {
  if (!store.getAccountAuthenticationGeneration) return 0;
  try {
    return await store.getAccountAuthenticationGeneration(subject);
  } catch (error) {
    // Pre-045 ordinary Postgres deployments have no generation relation.
    // Every other database failure must fail closed.
    if (isPreGenerationPostgresSchema(error)) return 0;
    throw error;
  }
}

export function isPreGenerationPostgresSchema(error: unknown): boolean {
  const databaseError = error as { code?: string; message?: string } | null;
  return databaseError?.code === "42P01" && /\baccounts_v1\.hosted_identity_records\b/u.test(databaseError.message ?? "");
}
