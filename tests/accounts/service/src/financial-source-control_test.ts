/** Actual Core facade -> Accounts adapter integration. Owner enrollment and
 * foreign Financial receiver custody are explicitly synthetic test ports;
 * these tests do not qualify a deployed graph, payer or production service. */
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import * as AccountsFinancialSource from "../../../../accounts/service/src/financial-source.ts";
import type { AccountsFinancialReceiver } from "../../../../accounts/service/src/financial-source.ts";
import {
  canonicalFinancialSourceJson,
  financialSourceEventDigest,
  parseFinancialSourceEvent,
  type FinancialSourceMaterialization,
  type FinancialSourceReceipt,
  type FinancialSourceRegistration,
} from "../../../../accounts/service/src/financial-source-contract.ts";
import { makeFinancialSourceReceipt } from "../../../../accounts/service/src/financial-source-abi.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { rotateAccountSession } from "../../../../accounts/service/src/account-session.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import {
  workerdD1Database,
  workerdD1Module,
} from "../../../helpers/deploy-control/workerd_d1.ts";

const actor = "control_original_actor";
const member = "control_other_member";
type Backend = "memory" | "postgres" | "native-d1";

async function enrolled(store: OpenTofuControlStore, label: string, now: () => number) {
  let serial = 0;
  const owner = new WorkspacesService({
    store, newId: (prefix) => `${prefix}_${label}_${++serial}`,
    now: () => new Date(now()),
  });
  const workspace = await owner.ensurePersonalWorkspaceForSharedAccount(actor, `control-${label}`);
  const intent = await owner.billingBindings.prepare({
    workspaceId: workspace.id, billingAuthority: "synthetic_financial_owner", actorAccountId: actor,
  });
  const binding = await owner.billingBindings.claim({
    workspaceId: workspace.id, intentId: intent.intentId, actorAccountId: actor,
    organizationRef: `original_org_${label}`, ownerAcknowledgementRef: "synthetic_existing_owner_ack",
  });
  const original = await owner.financialSource.prepareEnrollment({workspaceId: workspace.id});
  if (!original) throw new Error("actual enrollment census missing");
  // This is a synthetic qualified owner's registration, never implicit
  // enrollment by the adapter or evidence of actual external qualification.
  const registration = {
    sourceRef: `original_control_${label}`, incarnation: `original_incarnation_${label}`,
    genesisDigest: "a".repeat(64), requiredReceivers: [
      {receiverRef: "synthetic_financial_zeta", targetRef: "synthetic_target_one"},
      {receiverRef: "synthetic_financial_alpha", targetRef: "synthetic_target_two"},
    ],
  };
  const head = await owner.financialSource.enroll({original, registration});
  expect(head?.permissionSequence).toBe(0);
  return {owner, workspace, binding, registration, head};
}

async function fixture(backend: Backend, label: string) {
  let time = Date.parse("2026-10-15T00:00:00.000Z");
  let pg: PGliteSqlClient | undefined;
  let runtime: Miniflare | undefined;
  const close = async () => { await runtime?.dispose(); await pg?.close(); };
  try {
    let store: OpenTofuControlStore;
    if (backend === "memory") store = new InMemoryOpenTofuControlStore();
    else if (backend === "postgres") {
      pg = await PGliteSqlClient.create();
      store = new SqlOpenTofuControlStore({client: pg});
    } else {
      runtime = new Miniflare({
        compatibilityDate: "2026-07-17",
        modules: [workerdD1Module(`accounts-control-${label}.mjs`)],
        d1Databases: {CONTROL: `accounts-control-${label}`},
      });
      await runtime.ready;
      store = new CloudflareD1OpenTofuControlStore(workerdD1Database(runtime));
    }
    const f = await enrolled(store, label, () => time);
    // Only foreign receiver custody is synthetic. Raw events, materialization,
    // original receiver ACK custody and current snapshots belong to real Core.
    const accepted = new Map<string, FinancialSourceReceipt>();
    const wires = new Map<string, FinancialSourceMaterialization>();
    const commits = new Map<string, number>();
    const calls: string[] = [];
    let pauseSecondary = false, wrongTargetOnce = false, loseSecondaryAck = false;
    const secondary = f.registration.requiredReceivers[1]!.receiverRef;
    const receivers: AccountsFinancialReceiver[] = f.registration.requiredReceivers.map((receiver) => ({
      ...receiver,
      async read(wire) {
        const key = `${receiver.receiverRef}/${wire.event.eventRef}`;
        calls.push(`read:${key}`);
        return structuredClone(accepted.get(key));
      },
      async deliver(wire) {
        const key = `${receiver.receiverRef}/${wire.event.eventRef}`;
        expect(calls.at(-1)).toBe(`read:${key}`);
        calls.push(`deliver:${key}`);
        if (receiver.receiverRef === secondary && pauseSecondary)
          throw new Error("synthetic_secondary_unavailable");
        expect(await financialSourceEventDigest(wire.event)).toBe(wire.eventDigest);
        const input = {registrationRef: f.registration.sourceRef,
          receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
          event: wire.event, eventDigest: wire.eventDigest};
        if (receiver.receiverRef === secondary && wrongTargetOnce) {
          wrongTargetOnce = false;
          return makeFinancialSourceReceipt({...input, targetRef: "wrong_original_target"});
        }
        expect(accepted.has(key)).toBe(false);
        const receipt = await makeFinancialSourceReceipt(input);
        accepted.set(key, structuredClone(receipt));
        wires.set(wire.event.eventRef, structuredClone(wire));
        commits.set(receiver.receiverRef, (commits.get(receiver.receiverRef) ?? 0) + 1);
        if (receiver.receiverRef === secondary && loseSecondaryAck) {
          loseSecondaryAck = false;
          throw new Error("synthetic_lost_ack");
        }
        return receipt;
      },
    }));
    return {...f, store, receivers, accepted, wires, calls, close,
      now: () => time, setTime(value: number) { time = value; },
      pauseSecondary(value: boolean) { pauseSecondary = value; },
      wrongTargetReceipt() { wrongTargetOnce = true; },
      loseAck() { loseSecondaryAck = true; },
      commits: (receiverRef: string) => commits.get(receiverRef) ?? 0,
      adapter: (configured: readonly AccountsFinancialReceiver[] = receivers) =>
        AccountsFinancialSource.createAccountsFinancialControlSource({service: f.owner.financialSource, receivers: configured, now: () => time}),
    };
  } catch (error) { await close(); throw error; }
}

for (const backend of ["memory", "postgres", "native-d1"] as const) {
test(`${backend}: Control pre-proof reader uses fresh canonical sequence-one original only`, async () => {
  const f = await fixture(backend, `preproof-${backend}`);
  try {
    const adapter = f.adapter([]);
    const input = {workspaceId: f.workspace.id, accountId: actor};
    const genesis = await adapter.capture(input);
    await expect(adapter.prepareOriginalFinancialControlSource({...input,
      expectedSource: genesis!.evidence.source})).rejects.toThrow("source_pending");
    await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
      actorAccountId: actor, status: "active", roles: ["viewer"], requireCurrentMembership: true});
    // The existing delivery path prepares and acknowledges the actual Core
    // original. These callbacks are synthetic, not a qualified Financial M.
    const delivering = f.adapter();
    expect((await delivering.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).processed).toBe(1);
    const captured = await delivering.capture(input);
    expect(captured?.evidence.source.sequence).toBe(1);
    const prepared = await delivering.prepareOriginalFinancialControlSource({...input,
      expectedSource: captured!.evidence.source});
    expect(prepared.kind).toBe("fresh");
    expect(prepared.registration.registrationRef).toBe(f.registration.sourceRef);
    expect(prepared.original.key).toEqual({registrationRef: f.registration.sourceRef,
      incarnation: f.registration.incarnation, affectedRef: f.workspace.id});
    expect(prepared.original.eventRef).toBe(captured!.evidence.source.eventRef);
    expect(prepared.original.materialization.event.sequence).toBe(1);
    expect(prepared.original.materialization.event.previousDigest).toBe(`sha256:${f.registration.genesisDigest}`);
    await expect(delivering.prepareOriginalFinancialControlSource({...input,
      expectedSource: {...captured!.evidence.source, affectedRef: "caller-other-workspace"}})).rejects.toThrow("source_conflict");
    await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
      actorAccountId: actor, status: "active", roles: ["member"], requireCurrentMembership: true});
    await expect(delivering.prepareOriginalFinancialControlSource({...input,
      expectedSource: captured!.evidence.source})).rejects.toThrow();
    expect((await delivering.flush({workspaceId: f.workspace.id, afterSequence: 1, limit: 1})).processed).toBe(1);
    const later = await delivering.capture(input);
    expect(later?.evidence.source.sequence).toBe(2);
    await expect(delivering.prepareOriginalFinancialControlSource({...input,
      expectedSource: later!.evidence.source})).rejects.toThrow("source_pending");
  } finally { await f.close(); }
}, 30_000);
}

for (const backend of ["memory", "postgres", "native-d1"] as const) {
  test(`${backend}: actual enrolled Core genesis captures only current original Accounts context`, async () => {
    const f = await fixture(backend, `genesis-${backend}`);
    try {
      const adapter = f.adapter();
      const input = {workspaceId: f.workspace.id, accountId: actor};
      const snapshot = await adapter.capture(input);
      expect(snapshot).toMatchObject({
        workspaceId: f.workspace.id, accountId: actor,
        organizationId: f.binding.organizationRef, workspaceRef: f.binding.workspaceRef,
        evidence: {expiresAt: f.now() + 60_000, source: {
          registrationRef: f.registration.sourceRef, incarnation: f.registration.incarnation,
          affectedRef: f.workspace.id, sequence: 0, eventRef: null,
          eventDigest: `sha256:${f.registration.genesisDigest}`, receivers: f.registration.requiredReceivers,
        }},
      });
      expect(await adapter.assertCurrent(snapshot!)).toBe(true);
      expect(await adapter.assertCurrent(structuredClone(snapshot!))).toBe(false);
      const same = await adapter.capture(input);
      expect(same?.evidence.evidenceRef).toBe(snapshot!.evidence.evidenceRef);
      expect(same?.evidence.evidenceDigest).toBe(snapshot!.evidence.evidenceDigest);
      expect(await adapter.assertCurrent(same!)).toBe(true);
      Object.assign(same!, {organizationId: "caller_selected_organization"});
      expect(await adapter.assertCurrent(same!)).toBe(false);
      const tampered = await adapter.capture(input);
      Object.assign(tampered!.evidence.source, {affectedRef: "different_workspace"});
      expect(await adapter.assertCurrent(tampered!)).toBe(false);
      expect(await adapter.capture({...input, accountId: "unrelated_actor"})).toBeUndefined();
      const unenrolled = await f.owner.createWorkspaceForSharedAccount({
        handle: `unenrolled-${backend}`, displayName: "Unenrolled context", type: "organization", ownerUserId: actor,
      });
      expect(await adapter.capture({workspaceId: unenrolled.id, accountId: actor})).toBeUndefined();
      expect(await f.owner.financialSource.readHead(unenrolled.id)).toBeUndefined();
      expect(f.calls).toEqual([]);
      expect(await f.owner.financialSource.readHead(f.workspace.id)).toEqual(f.head);
    } finally { await f.close(); }
  }, 45_000);

  test(`${backend}: actual Core events retain raw custody through partial ACK, lost ACK, bounded pages and delete`, async () => {
    const f = await fixture(backend, `lifecycle-${backend}`);
    try {
      let adapter = f.adapter();
      const input = {workspaceId: f.workspace.id, accountId: actor};
      const before = await adapter.capture(input);
      await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
        actorAccountId: actor, status: "active", roles: ["viewer"], requireCurrentMembership: true});
      expect(await adapter.assertCurrent(before!)).toBe(false);
      expect(await adapter.capture(input)).toBeUndefined();
      const raw = (await f.owner.financialSource.listRawEvents({workspaceId: f.workspace.id, afterSequence: 0, limit: 64}))[0]!;
      expect(raw).toMatchObject({kind: "member-insert", permissionSequence: 1, previousEventRef: null, closed: false});
      const wrongTarget = f.adapter(f.receivers.map((receiver, index) => index === 1 ? {...receiver, targetRef: "caller_chosen_target"} : receiver));
      await expect(wrongTarget.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).rejects.toThrow("source_unavailable");
      expect(await f.owner.financialSource.readMaterialization(raw.eventRef)).toBeUndefined();
      f.pauseSecondary(true);
      await expect(adapter.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).rejects.toThrow("synthetic_secondary_unavailable");
      const stored = await f.owner.financialSource.readMaterialization(raw.eventRef);
      expect(stored?.rawPayloadJson).toBe(raw.payloadJson);
      const event = parseFinancialSourceEvent(JSON.parse(stored!.wireJson));
      expect(event).toEqual({v: 1, eventRef: raw.eventRef, registrationRef: f.registration.sourceRef,
        incarnation: f.registration.incarnation, sequence: 1, previousDigest: `sha256:${f.registration.genesisDigest}`,
        kind: "advance", affectedRef: f.workspace.id, evidenceRef: raw.eventRef});
      expect(stored!.wireJson).toBe(canonicalFinancialSourceJson(event));
      expect(await financialSourceEventDigest(event)).toBe(`sha256:${stored!.digest}`);
      expect(await f.owner.financialSource.listPendingEvents({workspaceId: f.workspace.id, receiverRef: f.receivers[0]!.receiverRef, afterSequence: 0, limit: 64})).toEqual([]);
      expect(await f.owner.financialSource.listPendingEvents({workspaceId: f.workspace.id, receiverRef: f.receivers[1]!.receiverRef, afterSequence: 0, limit: 64})).toHaveLength(1);
      expect(await adapter.capture(input)).toBeUndefined();
      f.pauseSecondary(false);
      f.wrongTargetReceipt();
      await expect(adapter.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).rejects.toThrow("source_conflict");
      expect(await adapter.capture(input)).toBeUndefined();
      f.loseAck();
      await expect(adapter.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).rejects.toThrow("synthetic_lost_ack");
      const originalReceipts = structuredClone([...f.accepted.entries()]);
      expect(await adapter.capture(input)).toBeUndefined();
      adapter = f.adapter(); // independent adapter; original remote readback survives
      expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).toEqual({processed: 1, nextAfterSequence: 1});
      expect(f.commits(f.receivers[0]!.receiverRef)).toBe(1);
      expect(f.commits(f.receivers[1]!.receiverRef)).toBe(1);
      expect([...f.accepted.entries()]).toEqual(originalReceipts);
      expect(await f.owner.financialSource.readMaterialization(raw.eventRef)).toEqual(stored);
      expect((await adapter.capture(input))?.evidence.source).toMatchObject({sequence: 1, eventRef: raw.eventRef, eventDigest: `sha256:${stored!.digest}`});
      for (const receiver of f.receivers)
        expect(await f.owner.financialSource.listPendingEvents({workspaceId: f.workspace.id, receiverRef: receiver.receiverRef, afterSequence: 0, limit: 64})).toEqual([]);

      await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
        actorAccountId: actor, status: "suspended", requireCurrentMembership: true});
      await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
        actorAccountId: actor, status: "active", roles: ["member"], requireCurrentMembership: true});
      expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 1, limit: 1})).toEqual({processed: 1, nextAfterSequence: 2});
      expect(await adapter.capture(input)).toBeUndefined();
      expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 2, limit: 1})).toEqual({processed: 1, nextAfterSequence: 3});
      const live = await adapter.capture(input);
      expect(live?.evidence.source.sequence).toBe(3);
      expect(await adapter.assertCurrent(live!)).toBe(true);
      expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 3, limit: 1})).toEqual({processed: 0});
      await f.owner.deleteWorkspaceForAccount(f.workspace.id, actor, undefined, {requireCurrentMembership: true});
      expect(await f.store.getWorkspace(f.workspace.id)).toBeUndefined();
      expect(await adapter.assertCurrent(live!)).toBe(false);
      const closed = await f.owner.financialSource.readHead(f.workspace.id);
      expect(closed).toMatchObject({closed: true, sourceRef: f.registration.sourceRef,
        incarnation: f.registration.incarnation, organizationRef: f.binding.organizationRef, workspaceRef: f.binding.workspaceRef});
      const terminal = await f.owner.financialSource.listRawEvents({workspaceId: f.workspace.id, afterSequence: 3, limit: 64});
      expect(terminal.length).toBeGreaterThan(0);
      expect(terminal.at(-1)).toMatchObject({kind: "workspace-delete", closed: true});
      expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 3, limit: 64})).toEqual({processed: terminal.length});
      for (const original of terminal) {
        const materialized = await f.owner.financialSource.readMaterialization(original.eventRef);
        expect(materialized?.rawPayloadJson).toBe(original.payloadJson);
      }
      const closeWire = f.wires.get(terminal.at(-1)!.eventRef)!;
      expect(closeWire.event.kind).toBe("close");
      for (const receiver of f.receivers)
        expect(f.accepted.get(`${receiver.receiverRef}/${closeWire.event.eventRef}`)?.state).toBe("admission-closed");
      expect(await adapter.capture(input)).toBeUndefined();
      expect(await f.store.getWorkspaceBillingBinding(f.workspace.id)).toEqual(f.binding);
      expect(await f.owner.financialSource.readMaterialization(raw.eventRef)).toEqual(stored);
      expect(await f.owner.financialSource.listRawEvents({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).toEqual([raw]);
      for (const [key, receipt] of originalReceipts) expect(f.accepted.get(key)).toEqual(receipt);
    } finally { await f.close(); }
  }, 45_000);
}

test("memory: Control adapter captures original callbacks and rejects expired/backward clocks", async () => {
  const f = await fixture("memory", "clock-callbacks");
  try {
    const adapter = f.adapter();
    f.receivers[0]!.read = async () => { throw new Error("replacement read must not be invoked"); };
    f.receivers[0]!.deliver = async () => { throw new Error("replacement delivery must not be invoked"); };
    await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
      actorAccountId: actor, status: "active", roles: ["viewer"], requireCurrentMembership: true});
    expect(await adapter.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).toEqual({processed: 1, nextAfterSequence: 1});
    const snapshot = await adapter.capture({workspaceId: f.workspace.id, accountId: actor});
    expect(await adapter.assertCurrent(snapshot!)).toBe(true);
    f.setTime(snapshot!.evidence.expiresAt);
    expect(await adapter.assertCurrent(snapshot!)).toBe(false);
    const fresh = await adapter.capture({workspaceId: f.workspace.id, accountId: actor});
    expect(fresh!.evidence.evidenceRef).toBe(snapshot!.evidence.evidenceRef);
    expect(await adapter.assertCurrent(fresh!)).toBe(true);
    f.setTime(f.now() - 1);
    await expect(adapter.assertCurrent(fresh!)).rejects.toThrow("source_unavailable");
    const invalid = AccountsFinancialSource.createAccountsFinancialControlSource({service: f.owner.financialSource, now: () => Number.NaN});
    await expect(invalid.capture({workspaceId: f.workspace.id, accountId: actor})).rejects.toThrow("source_unavailable");
  } finally { await f.close(); }
});

test("memory: awaited actual Core capture and raw reads pin original primitive caller inputs", async () => {
  const f = await fixture("memory", "input-await");
  try {
    const service = f.owner.financialSource;
    const realCapture = service.captureFinancialSourceSnapshot;
    let captureEntered!: () => void, releaseCapture!: () => void;
    const entered = new Promise<void>((resolve) => { captureEntered = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseCapture = resolve; });
    service.captureFinancialSourceSnapshot = async (input) => {
      const original = await Reflect.apply(realCapture, service, [input]);
      captureEntered(); await barrier; return original;
    };
    const adapter = f.adapter();
    const input = {workspaceId: f.workspace.id, accountId: actor};
    const pending = adapter.capture(input);
    await entered;
    input.workspaceId = "caller_replacement_workspace";
    input.accountId = "caller_replacement_actor";
    releaseCapture();
    const snapshot = await pending;
    service.captureFinancialSourceSnapshot = realCapture;
    expect(snapshot).toMatchObject({workspaceId: f.workspace.id, accountId: actor});
    expect(await adapter.assertCurrent(snapshot!)).toBe(true);

    await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
      actorAccountId: actor, status: "active", roles: ["viewer"], requireCurrentMembership: true});
    const realList = service.listRawEvents;
    let listEntered!: () => void, releaseList!: () => void;
    const listStarted = new Promise<void>((resolve) => { listEntered = resolve; });
    const listBarrier = new Promise<void>((resolve) => { releaseList = resolve; });
    service.listRawEvents = async (request) => {
      const original = await Reflect.apply(realList, service, [request]);
      listEntered(); await listBarrier; return original;
    };
    const flushAdapter = f.adapter();
    const request = {workspaceId: f.workspace.id, afterSequence: 0, limit: 1};
    const flushing = flushAdapter.flush(request);
    await listStarted;
    request.workspaceId = "caller_replacement_workspace";
    request.afterSequence = 42;
    request.limit = 64;
    releaseList();
    expect(await flushing).toEqual({processed: 1, nextAfterSequence: 1});
    service.listRawEvents = realList;
    expect((await flushAdapter.capture({workspaceId: f.workspace.id, accountId: actor}))?.evidence.source.sequence).toBe(1);
  } finally { await f.close(); }
});

test("memory: C event-evidence reader returns immutable actual Core history with explicit synthetic qualification", async () => {
  const f = await fixture("memory", "c-evidence-reader");
  try {
    const publisher = f.adapter();
    await f.owner.upsertWorkspaceMember({workspaceId: f.workspace.id, accountId: member,
      actorAccountId: actor, status: "active", roles: ["viewer"], requireCurrentMembership: true});
    const raw = (await f.owner.financialSource.listRawEvents({workspaceId: f.workspace.id, afterSequence: 0, limit: 64}))[0]!;
    expect(await publisher.flush({workspaceId: f.workspace.id, afterSequence: 0, limit: 1})).toEqual({processed: 1, nextAfterSequence: 1});
    const stored = (await f.owner.financialSource.readMaterialization(raw.eventRef))!;
    const event = parseFinancialSourceEvent(JSON.parse(stored.wireJson));
    const request = {v: 1 as const, eventRef: raw.eventRef, eventDigest: `sha256:${stored.digest}` as const};
    const registration: FinancialSourceRegistration = {
      registrationRef: f.registration.sourceRef, incarnation: f.registration.incarnation,
      genesisDigest: `sha256:${f.registration.genesisDigest}`, receivers: f.registration.requiredReceivers,
    };
    // These owner registry/key/clock ports are SYNTHETIC qualification fixtures.
    // Matching their descriptors never qualifies an actual binding or payer.
    const sourceCredentialRef = "synthetic_c_source_credential";
    const sourceSchemaRef = "synthetic_c_source_schema";
    const receiverSchemaRef = "synthetic_c_receiver_schema";
    const clockPolicyRef = "synthetic_c_clock";
    const receiver = f.registration.requiredReceivers[0]!;
    const registeredHead = {v: 1 as const,
      head: {registrationRef: registration.registrationRef, incarnation: registration.incarnation, affectedRef: f.workspace.id},
      genesisDigest: registration.genesisDigest, receivers: registration.receivers,
      sourceSchemaRef, sourceCredentialRef, clockPolicyRef,
    };
    let missingContext = false, missingHead = false, wrongGenesis = false, missingPeer = false;
    const eventEvidence: NonNullable<Parameters<typeof AccountsFinancialSource.createAccountsFinancialControlSource>[0]["eventEvidence"]> = {
      registration, sourceCredentialRef, sourceSchemaRef,
      receiverRef: receiver.receiverRef, targetRef: receiver.targetRef, receiverSchemaRef,
      registeredHeads: {async readRegisteredHead(input) {
        expect(input).toEqual({v: 1, head: registeredHead.head});
        if (missingHead) return undefined;
        return structuredClone({...registeredHead,
          ...(wrongGenesis ? {genesisDigest: `sha256:${"b".repeat(64)}` as const} : {}),
          ...(missingPeer ? {receivers: registration.receivers.slice(0, 1)} : {}),
        });
      }},
      keyCustody: {async readCredentialContext(input) {
        expect(input).toEqual({credentialRef: sourceCredentialRef, receiverRef: receiver.receiverRef,
          targetRef: receiver.targetRef, receiverSchemaRef, purpose: "event-evidence-read"});
        if (missingContext) return undefined;
        return {credentialRef: sourceCredentialRef, incarnationRef: "synthetic_c_credential_incarnation",
          sourceSchemaRef, receiverRef: receiver.receiverRef, targetRef: receiver.targetRef,
          receiverSchemaRef, clockPolicyRef, purpose: "event-evidence-read", validUntil: f.now() + 120_000};
      }},
      clock: {policyRef: clockPolicyRef, nowMilliseconds: f.now},
    };
    const reader = AccountsFinancialSource.createAccountsFinancialControlSource({service: f.owner.financialSource, eventEvidence, now: f.now});
    const state = async () => ({
      workspace: await f.store.getWorkspace(f.workspace.id),
      head: await f.owner.financialSource.readHead(f.workspace.id),
      raw: await f.owner.financialSource.listRawEvents({workspaceId: f.workspace.id, afterSequence: 0, limit: 64}),
      materialization: await f.owner.financialSource.readMaterialization(raw.eventRef),
      binding: await f.store.getWorkspaceBillingBinding(f.workspace.id),
      foreignReceipts: structuredClone([...f.accepted.entries()]),
    });
    const before = await state();
    const loaded = await reader.loadFinancialSourceEventEvidence(request);
    expect(loaded).toEqual({v: 1, status: "found", materialization: {event, eventDigest: request.eventDigest}, registeredHead});
    expect(Object.keys(loaded).sort()).toEqual(["v", "status", "materialization", "registeredHead"].sort());
    if (loaded.status !== "found") throw new Error("actual Core evidence missing");
    expect(Object.keys(loaded.materialization).sort()).toEqual(["event", "eventDigest"]);
    expect(loaded.materialization).not.toHaveProperty("rawEventDigest");
    expect(await reader.loadFinancialSourceEventEvidence({...request, eventRef: "not-an-accounts-fallback"})).toEqual({v: 1, status: "not-found"});
    await expect(publisher.loadFinancialSourceEventEvidence(request)).rejects.toThrow("unavailable");
    missingContext = true;
    await expect(reader.loadFinancialSourceEventEvidence(request)).rejects.toThrow("unavailable");
    missingContext = false;
    missingHead = true;
    await expect(reader.loadFinancialSourceEventEvidence(request)).rejects.toThrow("unregistered-source");
    missingHead = false;
    wrongGenesis = true;
    await expect(reader.loadFinancialSourceEventEvidence(request)).rejects.toThrow("unregistered-source");
    wrongGenesis = false;
    missingPeer = true;
    await expect(reader.loadFinancialSourceEventEvidence(request)).rejects.toThrow("unregistered-source");
    missingPeer = false;
    await expect(reader.loadFinancialSourceEventEvidence({...request, eventDigest: `sha256:${"f".repeat(64)}`})).rejects.toThrow("conflict");
    expect(await reader.loadFinancialSourceEventEvidence(request)).toEqual(loaded);
    expect(await state()).toEqual(before);

    await f.owner.deleteWorkspaceForAccount(f.workspace.id, actor, undefined, {requireCurrentMembership: true});
    const afterDelete = await state();
    expect(afterDelete.workspace).toBeUndefined();
    expect(afterDelete.head?.closed).toBe(true);
    const terminal = afterDelete.raw.at(-1)!;
    expect(terminal).toMatchObject({kind: "workspace-delete", closed: true});
    expect(await f.owner.financialSource.readMaterialization(terminal.eventRef)).toBeUndefined();
    expect(await reader.loadFinancialSourceEventEvidence(request)).toEqual(loaded);
    // A retained raw close is not silently materialized by a read, and an old
    // acknowledged event stays historical even after actual Workspace deletion.
    expect(await reader.loadFinancialSourceEventEvidence({v: 1, eventRef: terminal.eventRef, eventDigest: `sha256:${"e".repeat(64)}`})).toEqual({v: 1, status: "not-found"});
    expect(await f.owner.financialSource.readMaterialization(terminal.eventRef)).toBeUndefined();
    expect(await state()).toEqual(afterDelete);
  } finally { await f.close(); }
});


test("memory: original Accounts proof survives fresh actual Control wrapper expiry without renewing its original bounds", async () => {
  const f = await fixture("memory", "proof-retry-clock");
  try {
    const store = new InMemoryAccountsStore(), issuer = "https://accounts-control-retry.fixture.invalid";
    await store.saveAccount({subject: actor, createdAt: f.now(), updatedAt: f.now()});
    const login = await rotateAccountSession({store, subject: actor, now: f.now(), ttlMs: 600_000, hostedPolicy: true});
    const session = (await store.findAccountSession(login.sessionId))!;
    const token = "isolated-actual-core-retry-access", sid = "actual-core-retry-sid", clientId = "actual-core-retry-client";
    await store.saveAccessToken(token, {issuer, clientId, subject: actor, takosumiSubject: actor, oidcProfile: "shared-account", sid,
      issuerSessionId: session.issuerSessionId, identityGeneration: 0, authTime: 0, scope: "openid", expiresAt: f.now() + 200_000});
    await store.saveHostedOidcGrant({issuer, clientId, subject: actor, sid, issuerSessionId: session.issuerSessionId!, identityGeneration: 0,
      authTime: 0, scope: "openid", createdAt: f.now(), absoluteExpiresAt: f.now() + 300_000});
    const registration = {registrationRef: "accounts-distinct-from-control", incarnation: "accounts-retry-incarnation",
      genesisDigest: `sha256:${"b".repeat(64)}` as const, receivers: [{receiverRef: "synthetic-owner", targetRef: "synthetic-target"}]};
    await store.registerFinancialSourceRegistration(registration);
    const challenge = {v: 1 as const, challengeRef: "actual-core-retry-challenge", registrationRef: registration.registrationRef, clientId,
      workspaceId: f.workspace.id, organizationId: f.binding.organizationRef, workspaceRef: f.binding.workspaceRef,
      requestFingerprint: `sha256:${"c".repeat(64)}` as const, createdAt: f.now(), expiresAt: f.now() + 120_000};
    const control = f.adapter(), accepted = new Map<string, FinancialSourceReceipt>();
    const options = {store, issuer, registration, now: f.now,
      clients: [{clientId, profile: "shared-account" as const, enabled: true, allowedScopes: ["openid"], redirectUris: ["https://client.fixture.invalid/callback"]}],
      challenges: {read: async () => structuredClone(challenge)}, control,
      receivers: registration.receivers.map(receiver => ({...receiver, read: async (m: FinancialSourceMaterialization) => accepted.get(m.event.eventRef),
        async deliver(m: FinancialSourceMaterialization) {const receipt = await makeFinancialSourceReceipt({...receiver, registrationRef: registration.registrationRef, event: m.event, eventDigest: m.eventDigest}); accepted.set(m.event.eventRef, receipt); return receipt;}}))};
    const input = {accessToken: token, challengeRef: challenge.challengeRef};
    const producer = AccountsFinancialSource.createAccountsFinancialSource(options);
    await expect(producer.prove(input)).rejects.toThrow("source_pending");
    await producer.flush({limit: 100});
    const issued = await producer.prove(input), original = (await store.findFinancialSourceProof(issued.proofRef))!;
    f.setTime(f.now() + 1_000);
    const fresh = await control.capture({workspaceId: f.workspace.id, accountId: actor});
    expect(fresh!.evidence.evidenceRef).toBe(original.control.evidenceRef);
    expect(fresh!.evidence.evidenceDigest).toBe(original.control.evidenceDigest);
    expect(fresh!.evidence.source).toEqual(original.control.source);
    expect(fresh!.evidence.expiresAt).toBeGreaterThan(original.control.expiresAt);
    expect(await AccountsFinancialSource.createAccountsFinancialSource(options).prove(input)).toEqual(issued);
    expect(await store.findFinancialSourceProof(issued.proofRef)).toEqual(original);
    f.setTime(original.expiresAt);
    await expect(producer.prove(input)).rejects.toThrow("source_conflict");
    expect(await store.findFinancialSourceProof(issued.proofRef)).toEqual(original);
  } finally { await f.close(); }
});
