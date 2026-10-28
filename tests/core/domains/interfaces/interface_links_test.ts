import { expect, test } from "bun:test";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { InterfaceLink } from "takosumi-contract/interfaces";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InterfaceService, InterfaceServiceError, createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";

const NOW = "2026-07-13T12:00:00.000Z";
const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.read", "mcp.write"], delivery: { type: "oauth2" } } as const;

async function fixture(options: { readonly pending?: boolean; readonly issuer?: () => Promise<{ accessToken: string; expiresAt: string }> } = {}) {
  const stores = createInMemoryInterfaceStores();
  const capsules = new Map(["consumer", "provider_a", "provider_b"].map((id) => [id, { id, workspaceId: "ws", name: id, installConfigId: "config", status: "active" } as Capsule]));
  const state: { lookupFailure?: Error } = {};
  const service = new InterfaceService({ stores, now: () => NOW, capsules: { getCapsule: async (id) => { if (state.lookupFailure && id === "provider_a") throw state.lookupFailure; const capsule = capsules.get(id); if (!capsule) throw new OpenTofuControllerError("not_found", "Capsule not found"); return capsule; }, getInstallConfig: async () => ({ requiredInterfaces: [requirement] }) as unknown as InstallConfig }, oauth2ResourceAuthorizer: () => true, credentialIssuer: { issuePrincipalOAuth2Token: options.issuer ?? (async () => ({ accessToken: "runtime-token", expiresAt: "2026-07-13T12:01:00.000Z" })) }, ...(options.pending ? { linkApprovalPolicy: { evaluate: async () => undefined } } : {}) });
  const providers = await Promise.all(["provider_a", "provider_b"].map((id) => service.create({ workspaceId: "ws", name: id, ownerRef: { kind: "Capsule", id }, spec: { type: "mcp.server", version: "1", document: {}, inputs: { endpoint: { source: "literal", value: `https://${id}.example.test/mcp` } }, access: { visibility: "workspace", resourceUriInput: "endpoint" } } })));
  const link = async (index = 0) => (await service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: providers[index]!.metadata.id, selection: "explicit" }] }))[0]!;
  const ensure = (principalId = "pairwise_consumer") => service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId, requirements: [requirement] });
  return { stores, service, capsules, providers, link, ensure, state };
}

test("missing, pending and revoked links never infer one provider or block sign-in", async () => {
  const f = await fixture();
  await f.ensure();
  expect(await f.service.listBindings(f.providers[0]!.metadata.id)).toHaveLength(0);
  const link = await f.link();
  await f.service.revokeCapsuleInterfaceLink("consumer", "tools", link.generation);
  await f.ensure();
  expect(await f.service.listBindings(f.providers[0]!.metadata.id)).toHaveLength(0);
  const pending = await fixture({ pending: true });
  expect((await pending.link()).state).toBe("pending_approval");
  await pending.ensure();
  expect(await pending.service.listBindings(pending.providers[0]!.metadata.id)).toHaveLength(0);
});

test("active link pins provider and limits binding to requested intersect approved permissions", async () => {
  const f = await fixture();
  const link = await f.link();
  expect(link.approval?.kind).toBe("requester_manages_provider");
  const restricted: InterfaceLink = { ...link, generation: link.generation + 1, approvedPermissions: ["mcp.read", "unrequested"] };
  expect(await f.stores.links.compareAndSet(restricted, link.generation)).toBe(true);
  await f.ensure();
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  expect(binding.metadata.materializedFrom).toMatchObject({ linkId: link.id });
  expect(binding.spec.permissions).toEqual(["mcp.read"]);
  expect(await f.service.listBindings(f.providers[1]!.metadata.id)).toHaveLength(0);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).rejects.toThrow("grant not found");
});

test("repoint prepares known subjects, atomically replaces link and revokes old grants", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  await f.ensure("bob");
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
  expect(next.generation).toBe(3);
  expect((await f.stores.links.get(old.id))?.revoked?.reason).toBe("consumer_repointed");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).every((b) => b.status.phase === "Revoked")).toBe(true);
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).map((b) => b.spec.subjectRef.id).sort()).toEqual(["alice", "bob"]);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow();
  expect((await f.service.issueToken(f.providers[1]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).access_token).toBe("runtime-token");
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: old.generation })).rejects.toThrow("generation changed");
});

test("failed link CAS cleans preparatory grants without revoking current authority", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure();
  const original = f.stores.links.replace.bind(f.stores.links);
  f.stores.links.replace = async () => false;
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation })).rejects.toThrow("concurrently");
  f.stores.links.replace = original;
  expect((await f.stores.links.get(old.id))?.state).toBe("active");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id))[0]!.status.phase).toBe("Ready");
  expect((await f.service.listBindings(f.providers[1]!.metadata.id))[0]!.status.phase).toBe("Revoked");
});

test("link revoke independently blocks mint and existing OAuth evidence even before binding cleanup", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure();
  const iface = f.providers[0]!;
  const binding = (await f.service.listBindings(iface.metadata.id))[0]!;
  const evidence = { workspaceId: "ws", capsuleId: "provider_a", interfaceId: iface.metadata.id, bindingId: binding.metadata.id, interfaceResolvedRevision: iface.status.resolvedRevision, subjectId: "pairwise_consumer", permission: "mcp.read", resource: "https://provider_a.example.test/mcp" };
  expect(await f.service.validatePrincipalOAuth2TokenEvidence(evidence)).toBe(true);
  expect(await f.stores.links.compareAndSet({ ...link, state: "revoked", generation: link.generation + 1 }, link.generation)).toBe(true);
  expect((await f.service.listBindings(iface.metadata.id))[0]!.status.phase).toBe("Ready");
  expect(await f.service.validatePrincipalOAuth2TokenEvidence(evidence)).toBe(false);
  await expect(f.service.issueToken(iface.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).rejects.toThrow("grant not found");
  expect((await f.service.listAuthorizedForPrincipal({ workspaceId: "ws" }, "pairwise_consumer", "mcp.read")).length).toBe(0);
});

test("a link revoked while the issuer awaits never returns its token", async () => {
  let started!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ issuer: async () => { started(); await blocked; return { accessToken: "must-not-return", expiresAt: "2026-07-13T12:01:00.000Z" }; } });
  const link = await f.link();
  await f.ensure();
  const issued = f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" });
  await waiting;
  await f.service.revokeCapsuleInterfaceLink("consumer", "tools", link.generation);
  release();
  await expect(issued).rejects.toThrow("changed during credential issuance");
});

test("provider uninstall leaves link active and unavailable while consumer destroy revokes it", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure();
  await f.service.retireCapsule("ws", "provider_a");
  expect((await f.stores.links.get(link.id))?.state).toBe("active");
  await f.ensure("new_user");
  expect(await f.service.listBindings(f.providers[1]!.metadata.id)).toHaveLength(0);
  await f.service.retireCapsule("ws", "consumer");
  expect((await f.stores.links.get(link.id))?.state).toBe("revoked");
});

test("provider selection rejects cross-workspace and destroyed providers", async () => {
  const f = await fixture();
  const provider = f.capsules.get("provider_a")!;
  f.capsules.set("provider_a", { ...provider, workspaceId: "elsewhere" });
  expect((await f.service.listInterfaceLinkCandidates({ workspaceId: "ws", capsuleId: "consumer", requirement })).map((i) => i.metadata.ownerRef.id)).toEqual(["provider_b"]);
  await expect(f.link()).rejects.toThrow("unavailable");
  f.capsules.set("provider_a", { ...provider, status: "destroyed" });
  await expect(f.link()).rejects.toThrow("unavailable");
});

test("separate consumer pairwise subjects share one provider without sharing revocation", async () => {
  const f = await fixture();
  const first = await f.link();
  f.capsules.set("consumer_two", { ...f.capsules.get("consumer")!, id: "consumer_two", name: "consumer_two" });
  const [second] = await f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer_two", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, selection: "explicit" }] });
  await f.ensure("pairwise_one");
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer_two", principalId: "pairwise_two", requirements: [requirement] });
  await f.service.revokeCapsuleInterfaceLink("consumer", "tools", first.generation);
  expect((await f.stores.links.get(second!.id))?.state).toBe("active");
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_two" })).access_token).toBe("runtime-token");
});

test("materialization never overwrites or reuses an unrelated manual grant", async () => {
  const f = await fixture();
  await f.service.createBinding(f.providers[0]!.metadata.id, { subjectRef: { kind: "Principal", id: "pairwise_consumer" }, permissions: ["manual.permission"], delivery: { type: "oauth2" } });
  await f.link();
  await f.ensure();
  const bindings = await f.service.listBindings(f.providers[0]!.metadata.id);
  expect(bindings).toHaveLength(1);
  expect(bindings[0]!.spec.permissions).toEqual(["manual.permission"]);
  expect(bindings[0]!.metadata.materializedFrom).toBeUndefined();
});

test("same consumer cannot create separate requirement links to one active-subject provider", async () => {
  const f = await fixture();
  await f.link();
  const other = { ...requirement, key: "other" };
  // The accepted InstallConfig is checked, so use a local test service without
  // that port to isolate the existing store uniqueness contract.
  const service = new InterfaceService({ stores: f.stores, now: () => NOW });
  await expect(service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [other], selections: [{ requirementKey: "other", interfaceId: f.providers[0]!.metadata.id, selection: "explicit" }] })).rejects.toThrow("another consumer requirement");
  expect(await f.service.listCapsuleInterfaceLinks("consumer")).toHaveLength(1);
});

test("explicit links may select a private Interface when its provider is manageable", async () => {
  const f = await fixture();
  const provider = f.providers[0]!;
  const updated = await f.service.update(provider.metadata.id, { spec: { ...provider.spec, access: { ...provider.spec.access, visibility: "private" } } }, provider.metadata.generation);
  const selected = await f.link();
  expect(selected.providerInterfaceId).toBe(updated.metadata.id);
  await f.ensure();
  expect(await f.service.listBindings(updated.metadata.id)).toHaveLength(1);
});

test("bounded candidate inventory never treats a truncated set as one provider", async () => {
  const f = await fixture();
  const original = f.stores.interfaces.list.bind(f.stores.interfaces);
  f.stores.interfaces.list = async () => Array.from({ length: 1000 }, () => f.providers[0]!);
  await expect(f.service.listInterfaceLinkCandidates({ workspaceId: "ws", capsuleId: "consumer", requirement })).rejects.toThrow("exceeds bounded resolution");
  f.stores.interfaces.list = original;
});

test("write authority lost after preparation leaves old link active and cleans new grants", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure();
  let checks = 0;
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation }, undefined, { assertCurrent: async () => { if (++checks >= 4) throw new InterfaceServiceError("permission_denied", "caller was revoked"); return undefined; } })).rejects.toThrow("caller was revoked");
  expect((await f.stores.links.get(old.id))?.state).toBe("active");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id))[0]!.status.phase).toBe("Ready");
  expect((await f.service.listBindings(f.providers[1]!.metadata.id))[0]!.status.phase).toBe("Revoked");
});

test("consumer cleanup rereads after a concurrent repoint wins its old-link CAS", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure();
  const compare = f.stores.links.compareAndSet.bind(f.stores.links);
  let injected = false;
  f.stores.links.compareAndSet = async (record, generation, guard) => {
    if (!injected && record.id === old.id) {
      injected = true;
      await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
    }
    return compare(record, generation, guard);
  };
  await f.service.revokeCapsuleInterfaceLinks("ws", "consumer", "install_discarded");
  expect((await f.service.listCapsuleInterfaceLinks("consumer")).every((link) => link.state === "revoked")).toBe(true);
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).every((binding) => binding.status.phase === "Revoked")).toBe(true);
});

test("sign-in retries the current link when repoint wins during old provider materialization", async () => {
  const f = await fixture();
  const old = await f.link();
  const create = f.stores.bindings.create.bind(f.stores.bindings);
  let injected = false;
  f.stores.bindings.create = async (binding, authority) => {
    const wrote = await create(binding, authority);
    if (!injected && binding.spec.interfaceId === f.providers[0]!.metadata.id) {
      injected = true;
      await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
    }
    return wrote;
  };
  await f.ensure("late_subject");
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).some((binding) => binding.spec.subjectRef.id === "late_subject" && binding.status.phase === "Ready")).toBe(true);
});

test("missing provider is ordinary link unavailability while provider database errors propagate", async () => {
  const f = await fixture();
  await f.link();
  f.state.lookupFailure = new OpenTofuControllerError("not_found", "provider was removed");
  await f.ensure();
  expect(await f.service.listBindings(f.providers[0]!.metadata.id)).toHaveLength(0);
  f.state.lookupFailure = new Error("database unavailable");
  await expect(f.ensure()).rejects.toThrow("database unavailable");
});

test("uninstalled provider and consumer deny runtime grants while retaining link state", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure();
  for (const id of ["consumer", "provider_a"]) {
    const capsule = f.capsules.get(id)!;
    f.capsules.set(id, { ...capsule, status: "uninstalled" });
    await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).rejects.toThrow("grant not found");
    expect((await f.stores.links.get(link.id))?.state).toBe("active");
    f.capsules.set(id, capsule);
  }
});

test("late link insertion after discard observes destroyed consumer and revokes itself", async () => {
  const f = await fixture();
  const create = f.stores.links.create.bind(f.stores.links);
  f.stores.links.create = async (record, guard) => {
    f.capsules.set("consumer", { ...f.capsules.get("consumer")!, status: "destroyed" });
    return create(record, guard);
  };
  await expect(f.link()).rejects.toThrow("consumer Capsule is destroyed");
  expect((await f.service.listCapsuleInterfaceLinks("consumer")).every((link) => link.state === "revoked")).toBe(true);
});
