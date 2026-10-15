import { expect, test } from "bun:test";
import {
  canonicalFinancialSourceJson,
  financialReceiptMatches,
  financialSourceEventDigest,
  materializeFinancialSourceEvent,
  parseFinancialIdentityChallenge,
  parseFinancialSourceEvent,
  parseFinancialSourceRawEvent,
  parseFinancialSourceRegistration,
  parseFinancialSourceReceipt,
  type FinancialSourceDigest,
  type FinancialSourceEvent,
  type FinancialSourceRegistration,
} from "../../../../accounts/service/src/financial-source-contract.ts";

const genesis = `sha256:${"1".repeat(64)}` as FinancialSourceDigest;
const registration: FinancialSourceRegistration = {
  registrationRef: "source:accounts", incarnation: "incarnation:one", genesisDigest: genesis,
  receivers: [{ receiverRef: "receiver:financial", targetRef: "target:qualified" }],
};
const event: FinancialSourceEvent = {
  v: 1, eventRef: "event:one", registrationRef: registration.registrationRef,
  incarnation: registration.incarnation, sequence: 1, previousDigest: genesis,
  kind: "close", affectedRef: "grant:one", evidenceRef: "evidence:one",
};
const raw = { v: 1 as const, eventRef: event.eventRef, registrationRef: event.registrationRef,
  incarnation: event.incarnation, sequence: 1, previousEventRef: null, kind: "advance" as const,
  affectedRef: event.affectedRef, evidenceRef: event.evidenceRef };

test("event canonical bytes match an independent Python JSON/SHA256 vector", async () => {
  // json.dumps(sort_keys=True,separators=(',',':')) + hashlib.sha256,
  // independently computed from the literal wire, not this codec.
  expect(await financialSourceEventDigest(event)).toBe(
    "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93",
  );
  const reordered = Object.fromEntries(Object.entries(event).reverse());
  expect(await financialSourceEventDigest(parseFinancialSourceEvent(reordered))).toBe(await financialSourceEventDigest(event));
});

test("wire and registration reject extra fields, unsafe sequence, malformed digest and incomplete receivers", () => {
  for (const bad of [{ ...event, subject: "caller-selected" }, { ...event, sequence: 0 },
    { ...event, sequence: 1.5 }, { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, previousDigest: `sha256:${"A".repeat(64)}` }, { ...event, previousDigest: `sha256:${"a".repeat(43)}` },
    { ...event, kind: "reopen" }, { ...event, eventRef: "event\nforged" }]) {
    expect(() => parseFinancialSourceEvent(bad)).toThrow("invalid_financial_source_record");
  }
  expect(() => parseFinancialSourceRegistration({ ...registration, receivers: [] })).toThrow();
  expect(() => parseFinancialSourceRegistration({ ...registration, receivers: [...registration.receivers, ...registration.receivers] })).toThrow();
  expect(() => parseFinancialSourceRegistration({ ...registration, ready: true })).toThrow();
  const parsed = parseFinancialSourceRegistration(registration);
  expect(parsed).toEqual(registration);
  expect(parsed.receivers).not.toBe(registration.receivers);
});

test("raw capture materializes from enrolled genesis, then exact retained predecessor", async () => {
  const first = await materializeFinancialSourceEvent({ registration, raw });
  expect(first.event.previousDigest).toBe(genesis);
  expect(raw).not.toHaveProperty("previousDigest");
  const secondRaw = { ...raw, eventRef: "event:two", sequence: 2, previousEventRef: raw.eventRef, kind: "close" as const };
  const second = await materializeFinancialSourceEvent({ registration, raw: secondRaw, predecessor: first });
  expect(second.event.previousDigest).toBe(first.eventDigest);
  for (const predecessor of [undefined, { ...first, eventDigest: genesis },
    { ...first, event: { ...first.event, kind: "close" as const } },
    { ...first, event: { ...first.event, affectedRef: "grant:other" } }]) {
    await expect(materializeFinancialSourceEvent({ registration, raw: secondRaw, predecessor })).rejects.toThrow();
  }
  await expect(materializeFinancialSourceEvent({ registration, raw, predecessor: first })).rejects.toThrow();
  await expect(materializeFinancialSourceEvent({ registration: { ...registration, incarnation: "incarnation:other" }, raw })).rejects.toThrow();
  expect(() => parseFinancialSourceRawEvent({ ...raw, sequence: 0 })).toThrow();
  expect(() => parseFinancialSourceRawEvent({ ...raw, sequence: 2 })).toThrow();
});

test("exact receipt matches operation, digest, incarnation, sequence and closure state", async () => {
  const digest = await financialSourceEventDigest(event);
  const receipt = { v: 1 as const, eventRef: event.eventRef, eventDigest: digest,
    receiptRef: "receipt:one", incarnation: event.incarnation, sequence: 1, state: "admission-closed" as const };
  expect(financialReceiptMatches(event, digest, parseFinancialSourceReceipt(receipt))).toBeTrue();
  for (const bad of [{ ...receipt, eventRef: "event:other" }, { ...receipt, eventDigest: genesis },
    { ...receipt, incarnation: "incarnation:other" }, { ...receipt, sequence: 2 }, { ...receipt, state: "advanced" as const }]) {
    expect(financialReceiptMatches(event, digest, parseFinancialSourceReceipt(bad))).toBeFalse();
  }
  expect(() => parseFinancialSourceReceipt({ ...receipt, ready: true })).toThrow();
});

test("challenge is bounded and closed; it contains no claimed Principal or payer", () => {
  const challenge = { v: 1, challengeRef: "challenge:one", registrationRef: registration.registrationRef,
    clientId: "client:owned", workspaceId: "workspace:one", organizationId: "org:retained",
    workspaceRef: "workspace-ref:retained", requestFingerprint: genesis, createdAt: 1_000, expiresAt: 61_000 };
  expect(parseFinancialIdentityChallenge(challenge)).toEqual(challenge);
  for (const bad of [{ ...challenge, principalId: "caller-selected" }, { ...challenge, payer: true },
    { ...challenge, expiresAt: 1_000 }, { ...challenge, expiresAt: 301_001 },
    { ...challenge, requestFingerprint: "sha256:opaque-owner-evidence" }]) {
    expect(() => parseFinancialIdentityChallenge(bad)).toThrow();
  }
});

test("canonical identity bytes preserve Unicode and reject ambiguous or unsupported JSON", () => {
  expect(canonicalFinancialSourceJson({ z: "雪", a: [true, null, 1] })).toBe('{"a":[true,null,1],"z":"雪"}');
  for (const value of [NaN, Infinity, undefined, 1.5, "\ud800", new Date(), { secret: undefined }]) {
    expect(() => canonicalFinancialSourceJson(value)).toThrow();
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => canonicalFinancialSourceJson(cycle)).toThrow();
});

test("a sparse receiver slot cannot satisfy a complete registration", () => {
  expect(() => parseFinancialSourceRegistration({ ...registration, receivers: new Array(1) })).toThrow();
});

test("a sparse canonical array cannot alias an actual empty array", () => {
  expect(canonicalFinancialSourceJson([])).toBe("[]");
  expect(() => canonicalFinancialSourceJson(new Array(1))).toThrow();
});

test("actual array length is bounded even when sparse arrays have no enumerable keys", () => {
  expect(() => canonicalFinancialSourceJson(new Array(101))).toThrow();
});

test("extra named or symbol array properties are rejected rather than ignored", () => {
  expect(() => canonicalFinancialSourceJson(Object.assign([1], { extra: true }))).toThrow();
  const withSymbol = [1];
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true });
  expect(() => canonicalFinancialSourceJson(withSymbol)).toThrow();
});

test("a receiver array rejects extra properties even if every indexed entry is valid", () => {
  expect(() => parseFinancialSourceRegistration({ ...registration,
    receivers: Object.assign([...registration.receivers], { extra: true }) })).toThrow();
});

test("inherited receiver indices cannot stand in for own slots", () => {
  const receivers = new Array(1);
  const prototype = Object.create(Array.prototype);
  prototype[0] = registration.receivers[0];
  Object.setPrototypeOf(receivers, prototype);
  expect(() => parseFinancialSourceRegistration({ ...registration, receivers })).toThrow();
});
