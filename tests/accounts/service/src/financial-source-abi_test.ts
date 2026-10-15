import { expect, test } from "bun:test";
import {
  createFinancialSourceReceiverAdapter, financialSourceReceiptRef, financialSourceReceiptRecordDigest,
  makeFinancialSourceReceipt, parseFinancialSourceApplyRequest, verifyFinancialSourceApplyRequest,
  parseFinancialSourceReadRequest, parseFinancialSourceHeadKey, parseFinancialIdentityProofRequest,
  parseFinancialSourceEventEvidenceRequest, projectFinancialSourceEventEvidence,
  parseFinancialSourceEventEvidenceLoadResult, verifyFinancialSourceEventEvidenceLoadResult,
  type FinancialSourceReceiverAdapterOptions, type FinancialSourceApplyRequest, type FinancialSourceReadRequest,
} from "../../../../accounts/service/src/financial-source-abi.ts";
import { financialSourceEventDigest, type FinancialSourceEvent, type FinancialSourceMaterialization, type FinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-contract.ts";

const event: FinancialSourceEvent = {v: 1, eventRef: "event:one", registrationRef: "source:accounts", incarnation: "incarnation:one", sequence: 1,
  previousDigest: `sha256:${"1".repeat(64)}`, kind: "close", affectedRef: "grant:one", evidenceRef: "evidence:one"};
const digest = "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93" as const;
const receiverRef = "receiver:financial", targetRef = "target:qualified";
const materialization: FinancialSourceMaterialization = {rawEventDigest: `sha256:${"2".repeat(64)}`, event, eventDigest: digest};
const context = {registrationRef: event.registrationRef, receiverRef, targetRef};
const evidenceRequest = {v: 1 as const, eventRef: event.eventRef, eventDigest: digest};
const registeredHead = {v: 1 as const, head: {registrationRef: event.registrationRef, incarnation: event.incarnation, affectedRef: event.affectedRef},
  genesisDigest: event.previousDigest, receivers: [{receiverRef, targetRef}], sourceSchemaRef: "schema:synthetic-source",
  sourceCredentialRef: "credential:synthetic-source", clockPolicyRef: "clock:synthetic-ms"};
const evidenceResult = {v: 1 as const, status: "found" as const, materialization: {event, eventDigest: digest}, registeredHead};

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

test("immutable event evidence exposes only the original event and full registered head", async () => {
  const request = parseFinancialSourceEventEvidenceRequest({v: 1, eventRef: event.eventRef, eventDigest: digest});
  const result = await projectFinancialSourceEventEvidence({request, materialization, registeredHead});
  expect(result).toEqual({v: 1, status: "found", materialization: {event, eventDigest: digest}, registeredHead});
  expect(result.materialization).not.toHaveProperty("rawEventDigest");
});

test("event evidence request cannot choose caller, receiver, target, registration or missing digest", () => {
  for (const input of [event.eventRef, {v: 1, eventRef: event.eventRef}, {...evidenceRequest, v: 2},
    {...evidenceRequest, eventDigest: "sha256:opaque"}, {...evidenceRequest, eventRef: "bad\nref"},
    ...["subject", "payer", "receiverRef", "targetRef", "registrationRef", "sourceSchemaRef", "sourceCredentialRef", "clockPolicyRef"].map((key) => ({...evidenceRequest, [key]: "caller-selected"}))])
    expect(() => parseFinancialSourceEventEvidenceRequest(input)).toThrow();
});

test("event evidence absence is a closed result and still requires valid request and expected head", async () => {
  expect(parseFinancialSourceEventEvidenceLoadResult({v: 1, status: "not-found"})).toEqual({v: 1, status: "not-found"});
  expect(await verifyFinancialSourceEventEvidenceLoadResult({v: 1, status: "not-found"}, evidenceRequest, registeredHead)).toEqual({v: 1, status: "not-found"});
  for (const result of [undefined, null, {v: 1, status: "missing"}, {v: 2, status: "not-found"},
    {v: 1, status: "not-found", materialization: evidenceResult.materialization}, {v: 1, status: "not-found", raw: {}}])
    expect(() => parseFinancialSourceEventEvidenceLoadResult(result)).toThrow();
  await expect(verifyFinancialSourceEventEvidenceLoadResult({v: 1, status: "not-found"}, {...evidenceRequest, eventRef: ""}, registeredHead)).rejects.toThrow();
  await expect(verifyFinancialSourceEventEvidenceLoadResult({v: 1, status: "not-found"}, evidenceRequest,
    {...registeredHead, receivers: []})).rejects.toThrow();
});

test("event evidence result rejects raw metadata, internal scopes and hidden extra keys at every envelope", () => {
  for (const key of ["raw", "rawRecord", "parent", "cause", "accessTokenHash", "scope", "rawEventDigest"]) {
    expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, [key]: "private"})).toThrow();
    expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {...evidenceResult.materialization, [key]: "private"}})).toThrow();
    expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {event: {...event, [key]: "private"}, eventDigest: digest}})).toThrow();
  }
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, registeredHead: {...registeredHead, raw: "private"}})).toThrow();
  const symbol = Symbol("hidden-source-state");
  const hidden = {...evidenceResult}; Object.defineProperty(hidden, symbol, {value: true});
  expect(() => parseFinancialSourceEventEvidenceLoadResult(hidden)).toThrow();
});

test("event evidence also rejects hidden or accessor fields inside original event and receiver entries", () => {
  const hiddenEvent = {...event}; Object.defineProperty(hiddenEvent, Symbol("raw-parent"), {value: "private"});
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {event: hiddenEvent, eventDigest: digest}})).toThrow();
  const accessorEvent = {...event}; Object.defineProperty(accessorEvent, "evidenceRef", {get: () => event.evidenceRef, enumerable: true});
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {event: accessorEvent, eventDigest: digest}})).toThrow();
  const hiddenReceiver = {receiverRef, targetRef}; Object.defineProperty(hiddenReceiver, "cause", {value: "private"});
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, registeredHead: {...registeredHead, receivers: [hiddenReceiver]}})).toThrow();
});

test("event-derived three-part head and sequence-one genesis must match the original materialization", () => {
  for (const field of ["registrationRef", "incarnation", "affectedRef"] as const) {
    expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, registeredHead: {...registeredHead,
      head: {...registeredHead.head, [field]: "foreign"}}})).toThrow();
  }
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, registeredHead: {...registeredHead,
    genesisDigest: `sha256:${"0".repeat(64)}`}})).toThrow();
  expect(() => parseFinancialSourceEventEvidenceLoadResult({...evidenceResult, registeredHead: {...registeredHead,
    head: {registrationRef: event.registrationRef, incarnation: event.incarnation}}})).toThrow();
});

test("event evidence verifies request ref, claimed digest and actual event bytes independently", async () => {
  for (const input of [{...evidenceRequest, eventRef: "event:other"}, {...evidenceRequest, eventDigest: `sha256:${"0".repeat(64)}` as const}])
    await expect(verifyFinancialSourceEventEvidenceLoadResult(evidenceResult, input, registeredHead)).rejects.toThrow("invalid-request");
  const wrongDigest = `sha256:${"0".repeat(64)}` as const;
  await expect(verifyFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {event, eventDigest: wrongDigest}},
    {...evidenceRequest, eventDigest: wrongDigest}, registeredHead)).rejects.toThrow("invalid-request");
  await expect(verifyFinancialSourceEventEvidenceLoadResult({...evidenceResult, materialization: {event: {...event, evidenceRef: "changed-evidence"}, eventDigest: digest}},
    evidenceRequest, registeredHead)).rejects.toThrow("invalid-request");
});

test("verification pins the complete actual head including receiver set, schema, custody and clock", async () => {
  for (const expected of [{...registeredHead, receivers: [...registeredHead.receivers, {receiverRef: "other-receiver", targetRef: "other-target"}]},
    {...registeredHead, receivers: [{receiverRef, targetRef: "other-target"}]}, {...registeredHead, sourceSchemaRef: "other-schema"},
    {...registeredHead, sourceCredentialRef: "other-custody"}, {...registeredHead, clockPolicyRef: "other-clock"}])
    await expect(verifyFinancialSourceEventEvidenceLoadResult(evidenceResult, evidenceRequest, expected)).rejects.toThrow("invalid-request");
});

test("later immutable event evidence retains its original predecessor instead of substituting genesis", async () => {
  const later = {...event, eventRef: "event:later", sequence: 2, previousDigest: `sha256:${"3".repeat(64)}` as const};
  const eventDigest = await financialSourceEventDigest(later);
  const request = {v: 1 as const, eventRef: later.eventRef, eventDigest};
  const result = await projectFinancialSourceEventEvidence({request, materialization: {...materialization, event: later, eventDigest}, registeredHead});
  expect(result.materialization.event.previousDigest).toBe(later.previousDigest);
  expect(result.materialization.event.previousDigest).not.toBe(registeredHead.genesisDigest);
});

test("projection accepts only the internal materialization and returns no raw capture or caller fields", async () => {
  await expect(projectFinancialSourceEventEvidence({request: evidenceRequest, materialization: {...materialization, rawEventDigest: "invalid" as never}, registeredHead})).rejects.toThrow();
  const extra = {...materialization, cause: {accessTokenHash: "private"}};
  await expect(projectFinancialSourceEventEvidence({request: evidenceRequest, materialization: extra, registeredHead})).rejects.toThrow();
  const withCaller = {request: evidenceRequest, materialization, registeredHead, receiverRef: "caller-selected"};
  await expect(projectFinancialSourceEventEvidence(withCaller)).rejects.toThrow();
  const projected = await projectFinancialSourceEventEvidence({request: evidenceRequest, materialization, registeredHead});
  expect(Object.keys(projected).sort()).toEqual(["materialization", "registeredHead", "status", "v"]);
  expect(Object.keys(projected.materialization).sort()).toEqual(["event", "eventDigest"]);
});

test("event evidence verification captures original inputs before digest await and returns detached data", async () => {
  const request = structuredClone(evidenceRequest), result = structuredClone(evidenceResult), expected = structuredClone(registeredHead);
  const pending = verifyFinancialSourceEventEvidenceLoadResult(result, request, expected);
  request.eventRef = "late-request";
  result.materialization.event.evidenceRef = "late-evidence";
  expected.sourceCredentialRef = "late-custody";
  expect(await pending).toEqual(evidenceResult);
  expect(result.materialization.event.evidenceRef).toBe("late-evidence");
});
