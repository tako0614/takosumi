import type { AccountsStore } from "./store.ts";
import type { IdentityContextContinuation } from "./identity-context-state.ts";
import { assertIdentityContextPlanning } from "./identity-context.ts";
import {
  consumedProofReceipts,
  readIdentityMergeBrowserBindingHash,
} from "./identity-merge.ts";
import { readCredentialUnlinkBrowserSession } from "./identity-unlink.ts";
const stageOrigin = "https://auth-staging.takos.jp";
export function identityContextContinuationPath(url: URL): string | undefined {
  return url.origin === stageOrigin &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/identity-merges\/imrg_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/contexts$/u.test(
      url.pathname,
    )
    ? url.pathname
    : undefined;
}
export async function createIdentityContextContinuation(input: {
  request: Request;
  store: AccountsStore;
  target: URL;
  providerId: string;
  now: number;
}): Promise<IdentityContextContinuation> {
  const path = identityContextContinuationPath(input.target);
  if (!path || new URL(input.request.url).origin !== stageOrigin)
    throw new Error("invalid_context_continuation");
  const operationId = path.split("/")[2]!;
  const operation = await input.store.findIdentityMergeOperation?.(operationId);
  const session = await readCredentialUnlinkBrowserSession(
    input.store,
    input.request,
    input.now,
  );
  const browser = await readIdentityMergeBrowserBindingHash(input.request);
  if (
    !operation ||
    !session ||
    !browser ||
    browser !== operation.browserBindingHash ||
    !operation.contextPlan ||
    ![operation.sourceSubject, operation.targetSubject].includes(
      session.subject,
    ) ||
    !session.issuerSessionId
  )
    throw new Error("invalid_context_continuation");
  await assertIdentityContextPlanning(input.store, operation, input.now);
  const proofs = await consumedProofReceipts(
    input.store,
    operation,
    input.now,
    0,
  );
  const selected = proofs.filter((r) => r.subject!==session.subject && r.providerId === input.providerId);
  if (selected.length !== 1) throw new Error("ambiguous_context_provider");
  const expected = selected[0]!;
  return {
    path,
    operationId,
    operationRevision: operation.revision,
    sourceSubject: operation.sourceSubject,
    targetSubject: operation.targetSubject,
    currentSubject: session.subject,
    currentGeneration: session.identityGeneration ?? 0,
    issuerSessionHash: session.issuerSessionId,
    expectedSubject: expected.subject,
    providerId: expected.providerId,
    upstreamIssuer: expected.upstreamIssuer,
    upstreamSubject: expected.upstreamSubject,
    proofReceiptId: expected.receiptId,
    browserBindingHash: browser,
    policyVersion: operation.policyVersion,
    planDigest: operation.contextPlan.planDigest,
    createdAt: input.now,
    expiresAt: Math.min(
      operation.expiresAt,
      expected.expiresAt,
      input.now + 300000,
    ),
  };
}
export async function validateIdentityContextContinuation(input: {
  request: Request;
  store: AccountsStore;
  continuation: IdentityContextContinuation;
  now: number;
  exchange?: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  };
  accountSubject?: string;
}): Promise<void> {
  const c = input.continuation;
  const target = new URL(c.path, stageOrigin);
  if (
    new URL(input.request.url).origin !== stageOrigin ||
    identityContextContinuationPath(target) !== c.path ||
    !Number.isSafeInteger(c.createdAt) ||
    !Number.isSafeInteger(c.expiresAt) ||
    c.createdAt > input.now ||
    c.expiresAt <= input.now ||
    c.expiresAt > c.createdAt + 300000
  )
    throw new Error("invalid_context_continuation");
  const operation = await input.store.findIdentityMergeOperation?.(
    c.operationId,
  );
  const session = await readCredentialUnlinkBrowserSession(
    input.store,
    input.request,
    input.now,
  );
  const browser = await readIdentityMergeBrowserBindingHash(input.request);
  if (
    !operation ||
    !session ||
    operation.revision !== c.operationRevision ||
    operation.operationId !== target.pathname.split("/")[2] ||
    operation.sourceSubject !== c.sourceSubject ||
    operation.targetSubject !== c.targetSubject ||
    operation.browserBindingHash !== c.browserBindingHash ||
    browser !== c.browserBindingHash ||
    operation.policyVersion !== c.policyVersion ||
    operation.contextPlan?.planDigest !== c.planDigest ||
    session.subject !== c.currentSubject ||
    (session.identityGeneration ?? 0) !== c.currentGeneration ||
    session.issuerSessionId !== c.issuerSessionHash
  )
    throw new Error("invalid_context_continuation");
  await assertIdentityContextPlanning(input.store, operation, input.now);
  const proofs = await consumedProofReceipts(
    input.store,
    operation,
    input.now,
    0,
  );
  const proof = proofs.find((r) => r.receiptId === c.proofReceiptId);
  if (
    !proof ||
    proof.subject !== c.expectedSubject || proof.subject===c.currentSubject ||
    proof.providerId !== c.providerId ||
    proof.upstreamIssuer !== c.upstreamIssuer ||
    proof.upstreamSubject !== c.upstreamSubject ||
    !proofs.some((r) => r.subject === c.currentSubject)
  )
    throw new Error("invalid_context_continuation");
  if (
    input.exchange &&
    (input.exchange.providerId !== c.providerId ||
      input.exchange.upstreamIssuer !== c.upstreamIssuer ||
      input.exchange.upstreamSubject !== c.upstreamSubject)
  )
    throw new Error("wrong_context_identity");
  if (
    input.accountSubject !== undefined &&
    input.accountSubject !== c.expectedSubject
  )
    throw new Error("wrong_context_identity");
}
