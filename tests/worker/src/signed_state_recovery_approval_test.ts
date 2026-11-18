import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { stableStringify, toArrayBuffer } from "../../../core/adapters/source/digest.ts";
import type { PrivateStateStageApproval } from "../../../worker/src/private-state-recovery-approval.ts";
import { createSignedStateRecoveryApprovalIssuer, createSignedStateRecoveryApprovalReader,
  type SignedStateRecoveryApprovalRecord, type CurrentSignedStateRecoveryApprovalLookup } from "../../../worker/src/signed-state-recovery-approval.ts";

const NOW = Date.parse("2026-11-18T17:00:00.000Z");
const IDENTITY = { issuer: "local-worker-recovery-issuer", keyId: "local-p256-key", selectedTargetId: "local-worker-target" };
const APPROVAL: PrivateStateStageApproval = {
  format: "takosumi.private-worker-state-recovery-approval/v1", purpose: "stage-initial-create-state",
  approvedOperatorId: "synthetic-signed-operator", selectedTargetId: IDENTITY.selectedTargetId,
  workspaceId: "ws_signed", capsuleId: "cap_signed", environment: "synthetic",
  failedApplyRunId: "apply_failed_signed", recoveryRunId: "recovery_signed", sourceSnapshotId: "snapshot_signed",
  commandTimestamp: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 10_000).toISOString(),
  plaintextSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  custodyEvidenceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
async function keyPair(curve = "P-256") {
  return await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, false, ["sign", "verify"]);
}
async function fixture() {
  const keys = await keyPair();
  const clock = { now: NOW };
  const issuer = createSignedStateRecoveryApprovalIssuer({ ...IDENTITY, signingKey: keys.privateKey, now: () => clock.now });
  const issued = await issuer.issueStageApproval({ ...APPROVAL });
  const current = new Map<string, unknown>();
  const requests: { holderProofDigest: string }[] = [];
  const hooks: { read?: (count: number) => Promise<void> } = {};
  const lookup: CurrentSignedStateRecoveryApprovalLookup = {
    async readCurrentSignedStateRecoveryApproval(input) {
      requests.push({ ...input });
      await hooks.read?.(requests.length);
      return current.get(input.holderProofDigest);
    },
  };
  const reader = createSignedStateRecoveryApprovalReader({ ...IDENTITY, publicKey: keys.publicKey, currentLookup: lookup, now: () => clock.now });
  const input = { approvalRef: issued.approvalRef, purpose: APPROVAL.purpose, selectedTargetId: IDENTITY.selectedTargetId };
  const install = (record: SignedStateRecoveryApprovalRecord = issued.record) => current.set(issued.holderProofDigest, { status: "active", record });
  const resign = async (payload: string) => ({ ...issued.record, payload,
    signature: Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      toArrayBuffer(new TextEncoder().encode(payload)))).toString("base64url") });
  return { keys, clock, issuer, issued, current, requests, hooks, lookup, reader, input, install, resign };
}

test("signed recovery uses explicit keys and separate current publication, with only holder digest crossing lookup", async () => {
  const f = await fixture();
  expect(/^[A-Za-z0-9_-]{43}$/u.test(f.issued.approvalRef)).toBeTrue();
  expect(f.current.size).toBe(0); // Issuance is not current-row publication.
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  f.install();
  const approved = await f.reader.readApprovedStateRecovery(f.input);
  expect(approved).toEqual(APPROVAL);
  expect(Object.isFrozen(approved)).toBeTrue();
  expect(await f.reader.readApprovedStateRecovery(f.input)).toEqual(APPROVAL);
  expect(f.requests.length).toBe(5); // Missing once, then two fresh observations per valid read.
  expect(f.requests.every(r => Object.keys(r).join(",") === "holderProofDigest" &&
    r.holderProofDigest === f.issued.holderProofDigest)).toBeTrue();
  expect(JSON.stringify(f.requests).includes(f.issued.approvalRef)).toBeFalse();
  expect(f.issued.record.payload.includes(f.issued.approvalRef)).toBeFalse();
  expect(Object.keys(f.reader)).toEqual(["readApprovedStateRecovery"]);
  expect(Object.keys(f.issuer).sort()).toEqual(["issueCommitApproval", "issueStageApproval"]);
  const second = await f.issuer.issueStageApproval({ ...APPROVAL });
  expect(second.approvalRef === f.issued.approvalRef).toBeFalse();
  expect(second.holderProofDigest === f.issued.holderProofDigest).toBeFalse();
  expect(f.current.size).toBe(1); // The helper never activates a new issuance.
});

test("signed recovery rejects wrong public key, issuer, key identity, target, purpose and cross-holder record", async () => {
  const f = await fixture();
  f.install();
  const other = await keyPair();
  for (const change of [{ publicKey: other.publicKey }, { issuer: "other-issuer" }, { keyId: "other-key" }]) {
    const reader = createSignedStateRecoveryApprovalReader({ ...IDENTITY, publicKey: f.keys.publicKey,
      currentLookup: f.lookup, now: () => f.clock.now, ...change });
    expect(await reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  }
  expect(await f.reader.readApprovedStateRecovery({ ...f.input, selectedTargetId: "other-target" })).toBeUndefined();
  expect(await f.reader.readApprovedStateRecovery({ ...f.input, purpose: "commit-staged-initial-create-state" })).toBeUndefined();
  const otherHolder = await f.issuer.issueStageApproval({ ...APPROVAL });
  f.install(otherHolder.record);
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
});

test("signed recovery rejects tampered scope or hashes and valid signatures over the wrong domain or noncanonical bytes", async () => {
  const f = await fixture();
  const original = JSON.parse(f.issued.record.payload);
  for (const change of [{ workspaceId: "ws_other" }, { capsuleId: "cap_other" },
    { sourceSnapshotId: "snapshot_other" }, { plaintextSha256: "sha256:" + "c".repeat(64) },
    { custodyEvidenceDigest: "sha256:" + "d".repeat(64) }]) {
    f.install({ ...f.issued.record, payload: stableStringify({ ...original, approval: { ...original.approval, ...change } }) });
    expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  }
  for (const payload of [
    stableStringify({ ...original, domain: "takosumi.accounts.unrelated-effect/v1" }),
    stableStringify({ ...original, algorithm: "ES384" }),
    stableStringify({ ...original, role: "admin" }),
    stableStringify({ ...original, approval: { ...original.approval, role: "owner" } }),
    f.issued.record.payload + " ",
    f.issued.record.payload.slice(0, -1) + ',"issuer":"' + IDENTITY.issuer + '"}',
  ]) {
    f.install(await f.resign(payload)); // Cryptographically valid; protocol still refuses.
    expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  }
});

test("signed recovery malformed proof and signature encodings cannot alias a current approval", async () => {
  const f = await fixture();
  f.install();
  for (const proof of ["case-public-id", f.issued.holderProofDigest, f.issued.approvalRef + "=",
    " " + f.issued.approvalRef, f.issued.approvalRef.slice(0, -1) + "B"]) {
    expect(await f.reader.readApprovedStateRecovery({ ...f.input, approvalRef: proof })).toBeUndefined();
  }
  expect(f.requests.length).toBe(0);
  for (const signature of ["A".repeat(86), f.issued.record.signature + "=", "not-a-signature"]) {
    f.install({ ...f.issued.record, signature });
    expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  }
  f.current.set(f.issued.holderProofDigest, { status: "active", record: { ...f.issued.record, extra: true } });
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
});

test("signed recovery freshness rejects absence, revocation and change between both observations without caching", async () => {
  const f = await fixture();
  f.install();
  expect(await f.reader.readApprovedStateRecovery(f.input)).toEqual(APPROVAL);
  f.current.set(f.issued.holderProofDigest, { status: "revoked" });
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  f.current.delete(f.issued.holderProofDigest);
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  const g = await fixture();
  g.install();
  g.hooks.read = async count => { if (count === 2) g.current.set(g.issued.holderProofDigest, { status: "revoked" }); };
  expect(await g.reader.readApprovedStateRecovery(g.input)).toBeUndefined();
  const h = await fixture();
  h.install();
  h.hooks.read = async count => {
    if (count === 2) h.install({ ...h.issued.record, signature: "A".repeat(86) });
  };
  expect(await h.reader.readApprovedStateRecovery(h.input)).toBeUndefined();
});

test("signed recovery checks expiry before and after awaited current lookup and rejects expired issuance", async () => {
  for (const turn of [1, 2]) {
    const f = await fixture();
    f.install();
    f.hooks.read = async count => { if (count === turn) f.clock.now = Date.parse(APPROVAL.expiresAt); };
    expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
  }
  const f = await fixture();
  f.clock.now = Date.parse(APPROVAL.expiresAt);
  await expect(f.issuer.issueStageApproval({ ...APPROVAL })).rejects.toThrow("private state recovery");
  f.install();
  expect(await f.reader.readApprovedStateRecovery(f.input)).toBeUndefined();
});

test("signed recovery snapshots approved and signed scalar data before awaits", async () => {
  const f = await fixture();
  const mutable = { ...APPROVAL };
  const pending = f.issuer.issueStageApproval(mutable);
  mutable.workspaceId = "mutated-after-sign-request";
  const issued = await pending;
  f.current.set(issued.holderProofDigest, { status: "active", record: issued.record });
  const input = { ...f.input, approvalRef: issued.approvalRef };
  const read = f.reader.readApprovedStateRecovery(input);
  input.approvalRef = "mutated-after-read-request";
  expect(await read).toEqual(APPROVAL);
});

test("signed recovery reader cannot accept a signing key or another curve and signer cannot approve a stage receipt", async () => {
  const f = await fixture();
  expect(() => createSignedStateRecoveryApprovalReader({ ...IDENTITY, publicKey: f.keys.privateKey, currentLookup: f.lookup })).toThrow();
  expect(() => createSignedStateRecoveryApprovalIssuer({ ...IDENTITY, signingKey: f.keys.publicKey })).toThrow();
  const wrong = await keyPair("P-384");
  expect(() => createSignedStateRecoveryApprovalReader({ ...IDENTITY, publicKey: wrong.publicKey, currentLookup: f.lookup })).toThrow();
  const changed = { ...APPROVAL };
  Reflect.set(changed, "purpose", "staged-initial-create-state");
  await expect(f.issuer.issueStageApproval(changed)).rejects.toThrow();
});
