import { expect, test } from "bun:test";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { InterfaceService, createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { issueInterfaceOAuthAccessToken } from "../../../../accounts/service/src/interface-oauth-token.ts";

const NOW = Date.now();
const instant = new Date(NOW).toISOString();
const requirement = {
  key: "documents", interface: { type: "storage.object", version: "1" },
  permissions: ["object.read", "object.write"], delivery: { type: "oauth2.app-data.v1" },
} as const;

async function fixture(options: { onIssue?: () => Promise<void>; providerProof?: boolean; legacyProvider?: boolean } = {}) {
  const control = new InMemoryOpenTofuControlStore();
  const ownership = new InMemoryAppOwnershipStore(control);
  await control.putWorkspace({ id: "ws", handle: "fixture", displayName: "Fixture", type: "personal",
    status: "active", ownerUserId: "tsub_owner", createdAt: instant, updatedAt: instant });
  const capsules = new Map<string, Capsule>();
  for (const id of ["consumer", "provider", "other"]) {
    const capsule: Capsule = { id, workspaceId: "ws", projectId: "project", name: id, slug: id,
      installConfigId: "config", environment: "test", currentStateGeneration: 0,
      status: "active", createdAt: instant, updatedAt: instant };
    capsules.set(id, capsule);
    await control.putCapsule(capsule);
    if (options.legacyProvider && id === "provider") continue;
    expect(await ownership.initializeOwnershipIfMissing({ capsuleId: id, ownerAccountId: "tsub_owner",
      ownershipEpoch: 1, managementState: "active", managementEpoch: 1, storageRoot: `fixture/${id}` })).toBe(true);
  }
  expect(await ownership.putMember({ capsuleId: "consumer", accountId: "tsub_member", status: "active",
    addedBy: "tsub_owner", createdAt: instant, updatedAt: instant })).toBe(true);
  const accounts = new InMemoryAccountsStore();
  const stores = createInMemoryInterfaceStores();
  let issuerCalls = 0;
  const service = new InterfaceService({
    stores, appAccess: ownership, appOwnership: ownership, now: () => instant,
    capsules: { getCapsule: async (id: string) => capsules.get(id)!,
      getInstallConfig: async () => ({ requiredInterfaces: [requirement] }) as unknown as InstallConfig },
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: { async issuePrincipalOAuth2Token(input) {
      issuerCalls += 1;
      const issued = await issueInterfaceOAuthAccessToken({ store: accounts,
        subject: input.subjectId, appDataPrincipal: input.appDataPrincipal,
        workspaceId: input.workspaceId, capsuleId: "provider", audience: input.resource,
        permission: input.permission, interfaceId: input.interfaceId, bindingId: input.bindingId,
        interfaceRevision: input.interfaceResolvedRevision, appDataAuthority: input.appDataAuthority, now: NOW });
      await options.onIssue?.();
      return { accessToken: issued.accessToken, expiresAt: new Date(issued.expiresAt).toISOString() };
    } },
  });
  const iface = await service.create({ workspaceId: "ws", name: "storage",
    ownerRef: { kind: "Capsule", id: "provider" }, spec: { type: "storage.object", version: "1", document: {},
      inputs: { endpoint: { source: "literal", value: "https://storage.example.test/objects" } },
      access: { visibility: "private", resourceUriInput: "endpoint" } } });
  const links = await service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer",
    requirements: [requirement], selections: [{ requirementKey: "documents", interfaceId: iface.metadata.id, selection: "explicit" }] },
    { actorAccountId: "tsub_owner", roles: [], requestId: "fixture" },
    { assertCurrent: async () => undefined, ...(options.providerProof === false ? {} : { mayApproveProvider: async ({ capsuleId }: { capsuleId: string }) =>
      (await ownership.resolveAppAccess("tsub_owner", capsuleId))?.role === "owner" }) });
  for (const principalId of ["pairwise_owner", "pairwise_member"]) {
    await service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId,
      requirements: [requirement] });
  }
  const issue = (subjectId: string, accountSubject: string, permission = "object.read") =>
    service.issueToken(iface.metadata.id, { permission, dataScope: "app-shared.v1" },
      { workspaceId: "ws", subjectId, appDataPrincipal: { accountSubject, clientId: "fixture-client", scope: "openid profile" }, consumer: { capsuleId: "consumer" } });
  return { service, accounts, ownership, control, capsules, stores, iface, link: links[0]!, issue,
    issuerCalls: () => issuerCalls };
}

test("app-shared data preserves individual Principal grants and issues one verified app namespace", async () => {
  const f = await fixture();
  expect(f.link.state).toBe("active");
  const bindings = await f.service.listBindings(f.iface.metadata.id);
  expect(bindings).toHaveLength(2);
  expect(bindings.every(binding => binding.status.phase === "Ready")).toBe(true);
  expect(bindings[0]!.metadata.id).not.toBe(bindings[1]!.metadata.id);
  const a = await f.issue("pairwise_owner", "tsub_owner");
  const b = await f.issue("pairwise_member", "tsub_member");
  const ar = await f.accounts.findAccessToken(a.access_token);
  const br = await f.accounts.findAccessToken(b.access_token);
  expect(ar!.subject).toBe("pairwise_owner");
  expect(br!.subject).toBe("pairwise_member");
  expect(ar!.interfaceBindingId).not.toBe(br!.interfaceBindingId);
  expect(ar!.appDataAuthority!.namespace_id).toBe(br!.appDataAuthority!.namespace_id);
  expect(ar!.appDataAuthority!.app_role).toBe("owner");
  expect(br!.appDataAuthority!.app_role).toBe("member");
});


test("app-shared data never inherits permission-only requests or missing provider/member authority", async () => {
  const pending = await fixture({ providerProof: false });
  expect(pending.link.state).toBe("pending_approval");
  await expect(pending.issue("pairwise_member", "tsub_member")).rejects.toThrow();
  expect(pending.issuerCalls()).toBe(0);
  const f = await fixture();
  await expect(f.service.issueToken(f.iface.metadata.id, { permission: "object.read" },
    { workspaceId: "ws", subjectId: "pairwise_member", consumer: { capsuleId: "consumer" } })).rejects.toThrow();
  await expect(f.service.issueToken(f.iface.metadata.id, { permission: "object.read", dataScope: "app-shared.v1" },
    { workspaceId: "ws", subjectId: "pairwise_member", consumer: { capsuleId: "consumer" } })).rejects.toThrow();
  await expect(f.issue("pairwise_member", "tsub_nonmember")).rejects.toThrow();
  await expect(f.issue("pairwise_member", "tsub_member", "object.delete")).rejects.toThrow();
  expect(f.issuerCalls()).toBe(0);
});

test("app-shared data rejects member, link and provider races after the actual issuer await", async () => {
  for (const mutate of [
    async (f: Awaited<ReturnType<typeof fixture>>) => { await f.ownership.deleteMember("consumer", "tsub_member"); },
    async (f: Awaited<ReturnType<typeof fixture>>) => { await f.service.revokeCapsuleInterfaceLink("consumer", "documents", f.link.generation); },
    async (f: Awaited<ReturnType<typeof fixture>>) => { await f.service.update(f.iface.metadata.id,
      { spec: { ...f.iface.spec, inputs: { endpoint: { source: "literal", value: "https://other.example.test/objects" } } } },
      f.iface.metadata.generation); },
  ]) {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ onIssue: async () => await mutate(f) });
    await expect(f.issue("pairwise_member", "tsub_member")).rejects.toThrow();
    expect(f.issuerCalls()).toBe(1);
  }
});

test("app-shared data active evidence rejects namespace, app, provider, actor, epoch and permission substitution", async () => {
  const f = await fixture();
  const issued = await f.issue("pairwise_member", "tsub_member");
  const row = (await f.accounts.findAccessToken(issued.access_token))!;
  const evidence = { workspaceId: row.workspaceId, capsuleId: row.capsuleId, interfaceId: row.interfaceId!,
    bindingId: row.interfaceBindingId!, interfaceResolvedRevision: row.interfaceResolvedRevision!, subjectId: row.subject,
    permission: row.scope, resource: row.audience!, appDataAuthority: row.appDataAuthority!, accountSubject: row.takosumiSubject };
  expect(await f.service.validatePrincipalOAuth2TokenEvidence(evidence)).toBe(true);
  for (const delta of [
    { namespace_id: `appd_${"0".repeat(64)}` }, { consumer_capsule_id: "other" },
    { provider_capsule_id: "other" }, { ownership_epoch: 2 }, { app_role: "owner" as const },
    { interface_link_generation: evidence.appDataAuthority.interface_link_generation + 1 },
    { interface_binding_generation: evidence.appDataAuthority.interface_binding_generation + 1 },
    { interface_generation: evidence.appDataAuthority.interface_generation + 1 },
  ]) expect(await f.service.validatePrincipalOAuth2TokenEvidence({ ...evidence,
    appDataAuthority: { ...evidence.appDataAuthority, ...delta } }), JSON.stringify(delta)).toBe(false);
  for (const delta of [{ accountSubject: "tsub_nonmember" }, { subjectId: "pairwise_owner" },
    { resource: "https://other.example.test/objects" }, { permission: "object.delete" }]) {
    expect(await f.service.validatePrincipalOAuth2TokenEvidence({ ...evidence, ...delta })).toBe(false);
  }
  await f.ownership.deleteMember("consumer", "tsub_member");
  expect(await f.service.validatePrincipalOAuth2TokenEvidence(evidence)).toBe(false);
});

test("app-shared data stays with the app on ownership transfer and old epoch evidence is revoked", async () => {
  const f = await fixture();
  const before = await f.issue("pairwise_owner", "tsub_owner");
  const old = (await f.accounts.findAccessToken(before.access_token))!;
  const current = (await f.ownership.getOwnership("consumer"))!;
  expect(await f.ownership.putOwnership({ ...current, ownerAccountId: "tsub_member", ownershipEpoch: 2 }, 1)).toBe(true);
  const next = await f.issue("pairwise_member", "tsub_member");
  const row = (await f.accounts.findAccessToken(next.access_token))!;
  expect(row.appDataAuthority!.namespace_id).toBe(old.appDataAuthority!.namespace_id);
  expect(row.appDataAuthority!.ownership_epoch).toBe(2);
  expect(row.appDataAuthority!.app_role).toBe("owner");
  expect(await f.service.validatePrincipalOAuth2TokenEvidence({ workspaceId: old.workspaceId, capsuleId: old.capsuleId,
    interfaceId: old.interfaceId!, bindingId: old.interfaceBindingId!, interfaceResolvedRevision: old.interfaceResolvedRevision!,
    subjectId: old.subject, permission: old.scope, resource: old.audience!, appDataAuthority: old.appDataAuthority!,
    accountSubject: old.takosumiSubject })).toBe(false);
});


test("app-shared data cannot promote legacy Workspace provider authority or unmarked approvals", async () => {
  const legacy = await fixture({ legacyProvider: true });
  expect((await legacy.ownership.resolveAppAccess("tsub_owner", "provider"))?.role).toBe("owner");
  expect(await legacy.ownership.getOwnership("provider")).toBeUndefined();
  expect(legacy.link.state).toBe("pending_approval");
  const f = await fixture();
  const current = (await f.stores.links.get(f.link.id))!;
  const approval = current.approval!;
  expect(await f.stores.links.compareAndSet({ ...current, generation: current.generation + 1,
    approval: { kind: approval.kind, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt } }, current.generation)).toBe(true);
  await expect(f.issue("pairwise_member", "tsub_member")).rejects.toThrow();
  expect(f.issuerCalls()).toBe(0);
});

test("app-shared data provider ownership change invalidates old tokens and requires fresh consent", async () => {
  const f = await fixture();
  const issued = await f.issue("pairwise_member", "tsub_member");
  const row = (await f.accounts.findAccessToken(issued.access_token))!;
  const ownership = (await f.ownership.getOwnership("provider"))!;
  expect(await f.ownership.putOwnership({ ...ownership, ownerAccountId: "tsub_member", ownershipEpoch: 2 }, 1)).toBe(true);
  expect(await f.service.validatePrincipalOAuth2TokenEvidence({ workspaceId: row.workspaceId, capsuleId: row.capsuleId,
    interfaceId: row.interfaceId!, bindingId: row.interfaceBindingId!, interfaceResolvedRevision: row.interfaceResolvedRevision!,
    subjectId: row.subject, permission: row.scope, resource: row.audience!, appDataAuthority: row.appDataAuthority!,
    accountSubject: row.takosumiSubject })).toBe(false);
  await expect(f.issue("pairwise_member", "tsub_member")).rejects.toThrow();
  expect(f.issuerCalls()).toBe(1);
});

test("app-shared data manual approval records current provider app authority and rejects legacy fallback", async () => {
  const f = await fixture({ providerProof: false });
  const approved = await f.service.approveInterfaceLink({ providerCapsuleId: "provider", linkId: f.link.id,
    expectedGeneration: f.link.generation }, { actorAccountId: "tsub_owner", roles: [], requestId: "fixture" },
    { assertCurrent: async () => undefined });
  expect(approved.approval?.appDataAuthority).toEqual({ contract: "takosumi.interface-app-data/v1", providerOwnershipEpoch: 1 });
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "pairwise_member", requirements: [requirement] });
  expect((await f.issue("pairwise_member", "tsub_member")).token_use).toBe("interface_app_data");
  const legacy = await fixture({ legacyProvider: true, providerProof: false });
  await expect(legacy.service.approveInterfaceLink({ providerCapsuleId: "provider", linkId: legacy.link.id,
    expectedGeneration: legacy.link.generation }, { actorAccountId: "tsub_owner", roles: [], requestId: "fixture" },
    { assertCurrent: async () => undefined })).rejects.toThrow(/approval authority/);
  expect((await legacy.stores.links.get(legacy.link.id))!.state).toBe("pending_approval");
});

test("app-shared data provider epoch is fenced again before approval persistence", async () => {
  const f = await fixture({ providerProof: false });
  let fences = 0;
  await expect(f.service.approveInterfaceLink({ providerCapsuleId: "provider", linkId: f.link.id,
    expectedGeneration: f.link.generation }, { actorAccountId: "tsub_owner", roles: [], requestId: "fixture" },
    { assertCurrent: async () => {
      if (++fences === 2) {
        const prior = (await f.ownership.getOwnership("provider"))!;
        await f.ownership.putOwnership({ ...prior, ownerAccountId: "tsub_member", ownershipEpoch: 2 }, 1);
        await f.ownership.putMember({ capsuleId: "provider", accountId: "tsub_owner", status: "active",
          addedBy: "tsub_member", createdAt: instant, updatedAt: instant });
      }
      return undefined;
    } })).rejects.toThrow(/approval authority changed/);
  expect((await f.stores.links.get(f.link.id))!.state).toBe("pending_approval");
  expect((await f.ownership.resolveAppAccess("tsub_owner", "provider"))?.role).toBe("member");
});
