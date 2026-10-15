import { expect, test } from "bun:test";
import {
  createFinancialSourceReceiverAdapter, financialSourceReceiptRef, financialSourceReceiptRecordDigest,
  makeFinancialSourceReceipt, parseFinancialSourceApplyRequest, verifyFinancialSourceApplyRequest,
  parseFinancialSourceReadRequest, parseFinancialSourceHeadKey, parseFinancialIdentityProofRequest,
  type FinancialSourceReceiverAdapterOptions, type FinancialSourceApplyRequest, type FinancialSourceReadRequest,
} from "../../../../accounts/service/src/financial-source-abi.ts";
import type { FinancialSourceEvent, FinancialSourceMaterialization, FinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-contract.ts";

const event: FinancialSourceEvent = {v: 1, eventRef: "event:one", registrationRef: "source:accounts", incarnation: "incarnation:one", sequence: 1,
  previousDigest: `sha256:${"1".repeat(64)}`, kind: "close", affectedRef: "grant:one", evidenceRef: "evidence:one"};
const digest = "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93" as const;
const receiverRef = "receiver:financial", targetRef = "target:qualified";
const materialization: FinancialSourceMaterialization = {rawEventDigest: `sha256:${"2".repeat(64)}`, event, eventDigest: digest};
const context = {registrationRef: event.registrationRef, receiverRef, targetRef};

// All registration/key/clock/transport objects below are explicit SYNTHETIC
// source fixtures. They do not qualify a real key, binding graph or Financial DB.
async function fixture() {
  const originalReceipt = await makeFinancialSourceReceipt({...context, event, eventDigest: digest});
  let time = 1_000_000, applyCalls = 0, readCalls = 0;
  let missingHead = false, wrongAffected = false, missingKey = false;
  let result: FinancialSourceReceipt | undefined | null = originalReceipt;
  let fault: Error | undefined;
  let deferred: (() => Promise<void>) | undefined;
  const headsSeen: unknown[] = [], args: unknown[] = [];
  const options: FinancialSourceReceiverAdapterOptions = {
    receiverRef, targetRef, receiverSchemaRef: "schema:synthetic-receiver",
    clock: {policyRef: "clock:synthetic-ms", nowMilliseconds() {return time;}},
    heads: {async readRegisteredHead(input) {
      headsSeen.push(structuredClone(input)); await deferred?.();
      if (missingHead) return undefined;
      return {v: 1, head: {...input.head, ...(wrongAffected ? {affectedRef: "wrong-context"} : {})}, genesisDigest: event.previousDigest,
        receivers: [{receiverRef, targetRef}], sourceSchemaRef: "schema:synthetic-source", sourceCredentialRef: "credential:synthetic-source", clockPolicyRef: "clock:synthetic-ms"};
    }},
    credentials: {async readCredentialContext(input) {
      if (missingKey) return undefined;
      return {...input, incarnationRef: "credential-incarnation:synthetic", sourceSchemaRef: "schema:synthetic-source",
        clockPolicyRef: "clock:synthetic-ms", validUntil: 1_001_000};
    }},
    transport: {
      async applySourceEvent(input) {applyCalls++; args.push(structuredClone(input)); if (fault) throw fault; return result as FinancialSourceReceipt;},
      async readSourceEventReceipt(input) {readCalls++; args.push(structuredClone(input)); if (fault) throw fault; return result as FinancialSourceReceipt | undefined;},
    },
  };
  return {options, originalReceipt, args, headsSeen, calls: () => ({applyCalls, readCalls}),
    time: (v: number) => {time = v;}, result: (v: typeof result) => {result = v;}, fault: (v: Error) => {fault = v;},
    headMissing: () => {missingHead = true;}, wrongAffected: () => {wrongAffected = true;}, keyMissing: () => {missingKey = true;},
    deferred: (v: () => Promise<void>) => {deferred = v;}};
}

test("receipt reference and local record digest match independent Python canonical JSON vectors", async () => {
  const receipt = await makeFinancialSourceReceipt({...context, event, eventDigest: digest});
  expect(receipt.receiptRef).toBe("fsr_df35120d968c92051da0398de4d68fd0efc718f3302e671af09c09663b74c192");
  expect(await financialSourceReceiptRecordDigest({...context, receipt})).toBe("sha256:2a3fc7ee808cff8bbbc8805a20a06faff28b045628ae63b65b743f48f97751d9");
  const base = {registrationRef: event.registrationRef, receiverRef, targetRef, eventRef: event.eventRef, eventDigest: digest,
    incarnation: event.incarnation, sequence: 1, state: "admission-closed" as const};
  for (const patch of [{receiverRef: "other"}, {targetRef: "other"}, {sequence: 2}, {state: "advanced" as const}, {incarnation: "other"}])
    expect(await financialSourceReceiptRef({...base, ...patch})).not.toBe(receipt.receiptRef);
});

test("closed apply/read envelopes reject old local ports, unknown keys and claimed digest mismatch", async () => {
  expect(await verifyFinancialSourceApplyRequest({v: 1, event, eventDigest: digest})).toEqual({v: 1, event, eventDigest: digest});
  for (const value of [event, materialization, {v: 1, event, eventDigest: digest, receiverRef},
    {v: 1, event: {...event, callerSubject: "forged"}, eventDigest: digest}]) expect(() => parseFinancialSourceApplyRequest(value)).toThrow();
  await expect(verifyFinancialSourceApplyRequest({v: 1, event, eventDigest: `sha256:${"0".repeat(64)}`})).rejects.toThrow("invalid-request");
  for (const value of [event.eventRef, {v: 1, eventRef: event.eventRef}, {v: 1, registrationRef: event.registrationRef, eventRef: event.eventRef, eventDigest: digest, targetRef}])
    expect(() => parseFinancialSourceReadRequest(value)).toThrow();
  expect(parseFinancialSourceReadRequest({v: 1, registrationRef: event.registrationRef, eventRef: event.eventRef, eventDigest: digest}).eventDigest).toBe(digest);
});

test("owner head lookup always includes affectedRef and never falls back to global registration", async () => {
  expect(() => parseFinancialSourceHeadKey({registrationRef: event.registrationRef, incarnation: event.incarnation})).toThrow();
  const f = await fixture(), client = createFinancialSourceReceiverAdapter(f.options);
  await client.deliver(materialization);
  expect(f.headsSeen).toEqual([{v: 1, head: {registrationRef: event.registrationRef, incarnation: event.incarnation, affectedRef: event.affectedRef}}]);
  f.wrongAffected(); await expect(client.read(materialization)).rejects.toThrow("unregistered-source");
  expect(f.calls()).toEqual({applyCalls: 1, readCalls: 0});
});

test("missing enrollment, key custody or source dependencies refuse before transport", async () => {
  for (const variant of ["head", "key", "ports"] as const) {
    const f = await fixture();
    if (variant === "head") f.headMissing(); if (variant === "key") f.keyMissing();
    const client = createFinancialSourceReceiverAdapter(variant === "ports" ? {receiverRef, targetRef, receiverSchemaRef: "schema:synthetic"} : f.options);
    await expect(client.deliver(materialization)).rejects.toThrow();
    expect(f.calls()).toEqual({applyCalls: 0, readCalls: 0});
  }
});

test("captured ABI methods use local Reflect.apply without RPC function-property lookups", async () => {
  const f = await fixture(); let calls = 0;
  const callable = new Proxy(async function(this: object, input: FinancialSourceApplyRequest) {
    expect(this).toBe(f.options.transport!); expect(Object.keys(input).sort()).toEqual(["event", "eventDigest", "v"]);
    calls++; return f.originalReceipt;
  }, {get() {throw new Error("remote-function-property");}});
  f.options.transport!.applySourceEvent = callable;
  const client = createFinancialSourceReceiverAdapter(f.options);
  f.options.transport!.applySourceEvent = async () => {throw new Error("late-replaced-method");};
  expect(await client.deliver(materialization)).toEqual(f.originalReceipt); expect(calls).toBe(1);
});

test("request event and target are captured before an awaited owner lookup", async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const ownerStarted = new Promise<void>((resolve) => {started = resolve;});
  f.deferred(() => new Promise<void>((resolve) => {release = resolve; started();}));
  const client = createFinancialSourceReceiverAdapter(f.options);
  const m = structuredClone(materialization), pending = client.deliver(m);
  await ownerStarted;
  Object.assign(m.event, {affectedRef: "late-mutated"}); Object.assign(f.options, {targetRef: "late-target"});
  release(); await pending;
  expect((f.args[0] as FinancialSourceApplyRequest).event.affectedRef).toBe(event.affectedRef);
  expect(f.headsSeen).toEqual([{v: 1, head: {registrationRef: event.registrationRef, incarnation: event.incarnation, affectedRef: event.affectedRef}}]);
});

test("read undefined alone is absence; null, malformed receipt and wrong recipe fail closed", async () => {
  const f = await fixture(), client = createFinancialSourceReceiverAdapter(f.options);
  f.result(undefined); expect(await client.read(materialization)).toBeUndefined();
  f.result(null); await expect(client.read(materialization)).rejects.toThrow();
  f.result({...f.originalReceipt, receiptRef: `fsr_${"0".repeat(64)}`}); await expect(client.read(materialization)).rejects.toThrow("conflict");
  f.result(f.originalReceipt); f.fault(new Error("private-provider-diagnostic"));
  await expect(client.read(materialization)).rejects.toThrow("unavailable");
  expect(f.args.every((arg) => Object.keys(arg as object).sort().join() === "eventDigest,eventRef,registrationRef,v")).toBe(true);
});

test("expired or backward trusted clock cannot turn a completed remote write into local ACK", async () => {
  const f = await fixture();
  f.options.transport!.applySourceEvent = async () => {f.time(1_001_001); return f.originalReceipt;};
  await expect(createFinancialSourceReceiverAdapter(f.options).deliver(materialization)).rejects.toThrow("unavailable");
  const second = await fixture(), client = createFinancialSourceReceiverAdapter(second.options);
  await client.read(materialization); second.time(999_999);
  await expect(client.read(materialization)).rejects.toThrow("unavailable");
});

test("proof request accepts only immutable proof and exact challenge references", () => {
  expect(parseFinancialIdentityProofRequest({v: 1, proofRef: "proof:one", challengeRef: "challenge:one"})).toEqual({v: 1, proofRef: "proof:one", challengeRef: "challenge:one"});
  for (const value of [{v: 1, proofRef: "proof:one"}, {v: 1, proofRef: "proof:one", challengeRef: "challenge:one", subject: "caller"},
    {v: 1, proofRef: "proof:one", challengeRef: "challenge:one", current: true}]) expect(() => parseFinancialIdentityProofRequest(value)).toThrow();
});
