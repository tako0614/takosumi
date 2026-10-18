/// <reference path="../../../worker/src/cloudflare-workers-rpc.d.ts" />
import { WorkerEntrypoint } from "cloudflare:workers";
import type { PrivateAccountsFinancialSourceFacade } from "./handler.ts";
import { FinancialSourceUnavailable } from "../../../accounts/service/src/financial-source.ts";
import {
  parseFinancialIdentityProofCurrentResult,
  parseFinancialIdentityProofLoadResult,
  parseFinancialIdentityProofRequest,
} from "../../../accounts/service/src/financial-source-abi.ts";
import { financialSourceRef } from "../../../accounts/service/src/financial-source-contract.ts";
import {
  privateAccountsFinancialProofOwner,
  type AuthStagingWorker,
} from "./staging-worker.ts";
import type { AuthStagingEnv } from "./staging-owner-bundle.ts";

const facadeKeys = [
  "control",
  "flush",
  "loadFinancialIdentityProof",
  "loadFinancialSourceEventEvidence",
  "prepareFinancialIdentityProofSource",
  "preparePendingFinancialSourceOriginals",
  "prove",
  "verifyCurrentFinancialIdentityProof",
] as const;
const safeSourceCodes = [
  "source_unavailable",
  "invalid_grant",
  "invalid_challenge",
  "source_pending",
  "source_conflict",
] as const;

function invalidRequest(): FinancialSourceUnavailable {
  return new FinancialSourceUnavailable("source_conflict");
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length) throw invalidRequest();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw invalidRequest();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function proveInput(value: unknown): Readonly<{ accessToken: string; challengeRef: string }> {
  const input = exactRecord(value, ["accessToken", "challengeRef"]);
  if (typeof input.accessToken !== "string" || input.accessToken.length < 1 || input.accessToken.length > 8192 ||
    !financialSourceRef(input.challengeRef)) throw invalidRequest();
  return Object.freeze({ accessToken: input.accessToken, challengeRef: input.challengeRef });
}

function requestInput(value: unknown) {
  try {
    return parseFinancialIdentityProofRequest(value);
  } catch {
    throw invalidRequest();
  }
}

function capturedMethod(
  facade: PrivateAccountsFinancialSourceFacade,
  key: "prove" | "loadFinancialIdentityProof" | "verifyCurrentFinancialIdentityProof",
): (...args: readonly unknown[]) => Promise<unknown> {
  if (!Object.isFrozen(facade) || Object.getPrototypeOf(facade) !== Object.prototype ||
    Reflect.ownKeys(facade).map(String).sort().join(",") !== [...facadeKeys].sort().join(","))
    throw new FinancialSourceUnavailable("source_unavailable");
  const descriptor = Object.getOwnPropertyDescriptor(facade, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "function") throw new FinancialSourceUnavailable("source_unavailable");
  return descriptor.value as (...args: readonly unknown[]) => Promise<unknown>;
}

function safeFailure(error: unknown): never {
  try {
    if (error instanceof FinancialSourceUnavailable) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (typeof code === "string" && safeSourceCodes.includes(code as typeof safeSourceCodes[number]))
        throw new FinancialSourceUnavailable(code as typeof safeSourceCodes[number]);
    }
  } catch (safeError) {
    if (safeError instanceof FinancialSourceUnavailable) throw safeError;
  }
  throw new FinancialSourceUnavailable("source_unavailable");
}

function proofEntrypoint(worker: AuthStagingWorker) {
  const owner = (() => {
    const original = privateAccountsFinancialProofOwner(worker);
    if (!original) throw new FinancialSourceUnavailable("source_unavailable");
    return original;
  })();

  async function invoke(
    env: AuthStagingEnv,
    key: "prove" | "loadFinancialIdentityProof" | "verifyCurrentFinancialIdentityProof",
    input: unknown,
  ): Promise<unknown> {
    try {
      if (privateAccountsFinancialProofOwner(worker) !== owner) throw new FinancialSourceUnavailable("source_unavailable");
      await owner.assertReady(env);
      const facade = await owner.resolve(env);
      const method = capturedMethod(facade, key);
      const result = await Reflect.apply(method, facade, [input]);
      if (privateAccountsFinancialProofOwner(worker) !== owner) throw new FinancialSourceUnavailable("source_unavailable");
      const current = await owner.resolve(env);
      if (current !== facade || capturedMethod(current, key) !== method)
        throw new FinancialSourceUnavailable("source_unavailable");
      return result;
    } catch (error) {
      return safeFailure(error);
    }
  }

  return class AccountsFinancialProof extends WorkerEntrypoint<AuthStagingEnv> {
    fetch(): Response {
      return new Response("not_found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    async prove(input: unknown) {
      let request: Readonly<{ accessToken: string; challengeRef: string }>;
      try {
        if (arguments.length !== 1) throw invalidRequest();
        request = proveInput(input);
      } catch (error) {
        return safeFailure(error);
      }
      const result = await invoke(this.env, "prove", request);
      try {
        const parsed = exactRecord(result, ["proofRef"]);
        if (!financialSourceRef(parsed.proofRef)) throw invalidRequest();
        return Object.freeze({ proofRef: parsed.proofRef });
      } catch (error) {
        return safeFailure(error);
      }
    }

    async loadFinancialIdentityProof(input: unknown) {
      if (arguments.length !== 1) throw invalidRequest();
      const request = requestInput(input);
      const result = await invoke(this.env, "loadFinancialIdentityProof", request);
      try {
        const parsed = parseFinancialIdentityProofLoadResult(result);
        if (parsed.status === "found" &&
          (parsed.proof.proofRef !== request.proofRef || parsed.proof.challenge.challengeRef !== request.challengeRef))
          throw invalidRequest();
        return parsed;
      } catch {
        throw invalidRequest();
      }
    }

    async verifyCurrentFinancialIdentityProof(input: unknown) {
      if (arguments.length !== 1) throw invalidRequest();
      const request = requestInput(input);
      const result = await invoke(this.env, "verifyCurrentFinancialIdentityProof", request);
      try {
        const parsed = parseFinancialIdentityProofCurrentResult(result);
        if (parsed.status === "current" &&
          (parsed.proof.proofRef !== request.proofRef || parsed.proof.challenge.challengeRef !== request.challengeRef))
          throw invalidRequest();
        return parsed;
      } catch {
        throw invalidRequest();
      }
    }
  };
}

export function createAccountsFinancialProofEntrypoint(worker: AuthStagingWorker) {
  return proofEntrypoint(worker);
}
