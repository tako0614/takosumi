import { expect, test } from "bun:test";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { InterfaceLink } from "takosumi-contract/interfaces";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InterfaceService, InterfaceServiceError, createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";

const NOW = "2026-07-13T12:00:00.000Z";
const requirement = { key: "tools", interface: { type: "mcp.server", version: "1" }, permissions: ["mcp.read", "mcp.write"], delivery: { type: "oauth2" } } as const;

async function fixture(options: { readonly pending?: boolean; readonly issuer?: () => Promise<{ accessToken: string; expiresAt: string }> } = {}) {
  const stores = createInMemoryInterfaceStores();
  const capsules = new Map(["consumer", "provider_a", "provider_b"].map((id) => [id, { id, workspaceId: "ws", name: id, installConfigId: "config", status: "active" } as Capsule]));
  const state: { lookupFailure?: Error; capsuleReads: string[]; requirement: typeof requirement | { key: string; interface: { type: string; version: string }; permissions: readonly string[]; delivery: { type: string } } } = { requirement, capsuleReads: [] };
  const service = new InterfaceService({ stores, now: () => NOW, capsules: { getCapsule: async (id) => { state.capsuleReads.push(id); if (state.lookupFailure && id === "provider_a") throw state.lookupFailure; const capsule = capsules.get(id); if (!capsule) throw new OpenTofuControllerError("not_found", "Capsule not found"); return capsule; }, getInstallConfig: async () => ({ requiredInterfaces: [state.requirement] }) as unknown as InstallConfig }, oauth2ResourceAuthorizer: () => true, credentialIssuer: { issuePrincipalOAuth2Token: options.issuer ?? (async () => ({ accessToken: "runtime-token", expiresAt: "2026-07-13T12:01:00.000Z" })) }, ...(options.pending ? { linkApprovalPolicy: { evaluate: async () => undefined } } : {}) });
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

test("a domain failure in one required Interface still reconciles the next requirement", async () => {
  const f = await fixture();
  const read = f.stores.links.getCurrent.bind(f.stores.links);
  const visited: string[] = [];
  f.stores.links.getCurrent = async (key) => {
    visited.push(key.requirementKey);
    if (key.requirementKey === "tools") throw new InterfaceServiceError("failed_precondition", "v76 link ledger unavailable");
    return await read(key);
  };
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "pairwise_consumer", requirements: [requirement, { ...requirement, key: "other", interface: { type: "example.other", version: "1" } }] });
  expect(visited).toEqual(["tools", "other"]);
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

test("a provider outage after grant creation is cleaned up as retryable and recovers on sign-in", async () => {
  const f = await fixture();
  await f.link();
  const createBinding = f.service.createBinding.bind(f.service);
  f.service.createBinding = async (...args) => {
    const binding = await createBinding(...args);
    // The first provider availability check has passed; fail the Capsule
    // before the post-create check validates the new binding.
    f.capsules.get("provider_a")!.status = "error";
    return binding;
  };

  await f.ensure("alice");
  const cleanup = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  expect(cleanup.status.phase).toBe("Revoked");
  expect(cleanup.status.conditions?.[0]?.reason).toBe("Superseded");

  f.capsules.get("provider_a")!.status = "active";
  f.service.createBinding = createBinding;
  await f.ensure("alice");
  const ready = (await f.service.listBindings(f.providers[0]!.metadata.id)).filter((binding) => binding.status.phase === "Ready");
  expect(ready).toHaveLength(1);
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).access_token).toBe("runtime-token");
});

test("authorized binding list reads one link and each Capsule once", async () => {
  const f = await fixture();
  await f.link();
  await f.ensure();
  f.state.capsuleReads.length = 0;
  const get = f.stores.links.get.bind(f.stores.links);
  let linkReads = 0;
  f.stores.links.get = async (id) => { linkReads += 1; return await get(id); };
  expect(await f.service.listAuthorizedBindingsForPrincipal(f.providers[0]!.metadata.id, "pairwise_consumer", "mcp.read")).toHaveLength(1);
  expect(linkReads).toBe(1);
  expect(f.state.capsuleReads.sort()).toEqual(["consumer", "provider_a"]);
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
  const retried = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
  expect(retried.state).toBe("active");
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).filter((binding) => binding.status.phase === "Ready")).toHaveLength(1);
  expect((await f.service.issueToken(f.providers[1]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).access_token).toBe("runtime-token");
});

test("matching legacy required grant adopts the active link before the subject uniqueness check", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure();
  const current = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const source = current.metadata.materializedFrom;
  if (source?.source !== "capsule_required_interface") throw new Error("required grant expected");
  const legacy = { ...current, metadata: { ...current.metadata, generation: current.metadata.generation + 1, materializedFrom: { ...source, linkId: undefined } } };
  expect(await f.stores.bindings.compareAndSet(legacy, current.metadata.generation)).toBe(true);
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).access_token).toBe("runtime-token");
  await f.ensure();
  const adopted = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  expect(adopted.metadata.materializedFrom).toMatchObject({ linkId: link.id });
  expect(adopted.metadata.id).toBe(current.metadata.id);
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).access_token).toBe("runtime-token");
});

test("legacy wider grant mints only the permission approved by its active link", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure();
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const source = binding.metadata.materializedFrom;
  if (source?.source !== "capsule_required_interface") throw new Error("required grant expected");
  expect(await f.stores.bindings.compareAndSet({ ...binding, metadata: { ...binding.metadata, generation: binding.metadata.generation + 1, materializedFrom: { ...source, linkId: undefined } } }, binding.metadata.generation)).toBe(true);
  expect(await f.stores.links.compareAndSet({ ...link, generation: link.generation + 1, approvedPermissions: ["mcp.read"] }, link.generation)).toBe(true);
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).access_token).toBe("runtime-token");
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).rejects.toThrow("grant not found");
});

test("same-provider permission change replaces the old grant with the new pinned grant", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure();
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: old.generation });
  expect(next.id).not.toBe(old.id);
  expect(next.requestedPermissions).toEqual(["mcp.read"]);
  const bindings = await f.service.listBindings(f.providers[0]!.metadata.id);
  expect(bindings.filter((binding) => binding.status.phase === "Ready").map((binding) => binding.spec.permissions)).toEqual([["mcp.read"]]);
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "pairwise_consumer" })).access_token).toBe("runtime-token");
});

test("sign-in accepts reordered and reduced requirements without widening the active link", async () => {
  const f = await fixture();
  const link = await f.link();
  f.state.requirement = { ...requirement, permissions: ["mcp.write", "mcp.read"] };
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [f.state.requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id))[0]?.spec.permissions.slice().sort()).toEqual(["mcp.read", "mcp.write"]);
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [f.state.requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.spec.permissions)).toEqual([["mcp.read"]]);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
  expect((await f.stores.links.get(link.id))?.state).toBe("active");
});

test("successive sign-ins narrow a grant despite older revoked rows for the same link", async () => {
  const f = await fixture();
  await f.link();
  await f.ensure("alice");
  for (const permissions of [["mcp.read"], ["mcp.write"]]) {
    const nextRequirement = { ...requirement, permissions };
    await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [nextRequirement] });
  }
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.spec.permissions)).toEqual([["mcp.write"]]);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
  expect((await f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "alice" })).access_token).toBe("runtime-token");
});

test("zero approved overlap revokes an older required grant without creating an empty grant", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure("alice");
  const incompatible = { ...requirement, permissions: ["mcp.admin"] };
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [incompatible] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready")).toHaveLength(0);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [incompatible] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready")).toHaveLength(0);
  expect((await f.stores.links.get(link.id))?.state).toBe("active");
});

test("provider approval reduction to empty revokes a previously Ready required grant", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure("alice");
  expect(await f.stores.links.compareAndSet({ ...link, generation: link.generation + 1, approvedPermissions: [] }, link.generation)).toBe(true);
  await f.ensure("alice");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready")).toHaveLength(0);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
});

test("a legacy replacement's revoked row does not deny its newer active same-link grant", async () => {
  const f = await fixture();
  await f.link();
  await f.ensure("alice");
  const nextRequirement = { ...requirement, permissions: ["mcp.read"] };
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [nextRequirement] });
  const bindings = await f.service.listBindings(f.providers[0]!.metadata.id);
  const old = bindings.find((b) => b.status.phase === "Revoked")!;
  const preFix = { ...old, metadata: { ...old.metadata, generation: old.metadata.generation + 1 }, status: { ...old.status, conditions: old.status.conditions.map((condition) => ({ ...condition, reason: "Revoked" })) } };
  expect(await f.stores.bindings.compareAndSet(preFix, old.metadata.generation)).toBe(true);
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [nextRequirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.spec.permissions)).toEqual([["mcp.read"]]);
});

test("reordering a requirement does not rotate its approved link", async () => {
  const f = await fixture();
  const link = await f.link();
  f.state.requirement = { ...requirement, permissions: ["mcp.write", "mcp.read"] };
  const selected = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: link.generation });
  expect(selected.id).toBe(link.id);
  expect(selected.generation).toBe(link.generation);
});

test("a requirement increase grants only the approved overlap until a new link is approved", async () => {
  const f = await fixture();
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  const [link] = await f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [f.state.requirement], selections: [{ requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, selection: "explicit" }] });
  f.state.requirement = requirement;
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.spec.permissions)).toEqual([["mcp.read"]]);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
  await expect(f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, selection: "explicit" }] })).rejects.toThrow("selection changed");
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: link!.generation });
  expect(next.id).not.toBe(link!.id);
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.spec.permissions)).toEqual([["mcp.read", "mcp.write"]]);
});

test("stranded preparatory grant from an absent link is reclaimed on repoint", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  const current = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const stale = { ...current, metadata: { ...current.metadata, id: "ifb_stranded", materializedFrom: { ...current.metadata.materializedFrom!, linkId: "ifl_missing" } }, spec: { ...current.spec, interfaceId: f.providers[1]!.metadata.id } };
  expect(await f.stores.bindings.create(stale)).toBe(true);
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.metadata.materializedFrom?.linkId)).toEqual([next.id]);
  expect((await f.stores.bindings.get(stale.metadata.id))?.status.phase).toBe("Revoked");
});

test("competing preparation cannot leave the winning repoint without its principal grant", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  let enteredReplace!: () => void;
  let releaseReplace!: () => void;
  const atReplace = new Promise<void>((resolve) => { enteredReplace = resolve; });
  const blockedReplace = new Promise<void>((resolve) => { releaseReplace = resolve; });
  const replace = f.stores.links.replace.bind(f.stores.links);
  let first = true;
  f.stores.links.replace = async (...args) => { if (first) { first = false; enteredReplace(); await blockedReplace; } return replace(...args); };
  const winner = f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
  await atReplace;
  const prepared = (await f.service.listBindings(f.providers[1]!.metadata.id))[0]!;
  let enteredRevoke!: () => void;
  let releaseRevoke!: () => void;
  const atRevoke = new Promise<void>((resolve) => { enteredRevoke = resolve; });
  const blockedRevoke = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  const revoke = f.service.revokeBinding.bind(f.service);
  let pause = true;
  f.service.revokeBinding = async (...args) => { if (pause && args[1] === prepared.metadata.id) { pause = false; enteredRevoke(); await blockedRevoke; } return revoke(...args); };
  const loser = f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation });
  await atRevoke;
  releaseReplace();
  const selected = await winner;
  releaseRevoke();
  await expect(loser).rejects.toThrow();
  expect((await f.service.listBindings(f.providers[1]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => b.metadata.materializedFrom?.linkId)).toEqual([selected.id]);
  expect((await f.service.issueToken(f.providers[1]!.metadata.id, { permission: "mcp.read" }, { workspaceId: "ws", subjectId: "alice" })).access_token).toBe("runtime-token");
});

test("linkId-less grant from an older generation is recreated during preparation", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  const previous = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const revoke = f.service.revokeBinding.bind(f.service);
  f.service.revokeBinding = async (...args) => { if (args[1] === previous.metadata.id) throw new Error("old cleanup interrupted"); return revoke(...args); };
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id, expectedGeneration: old.generation })).rejects.toThrow("old cleanup interrupted");
  f.service.revokeBinding = revoke;
  const stranded = { ...previous, metadata: { ...previous.metadata, generation: previous.metadata.generation + 1, materializedFrom: { ...previous.metadata.materializedFrom!, linkId: undefined } } };
  expect(await f.stores.bindings.compareAndSet(stranded, previous.metadata.generation)).toBe(true);
  const current = await f.stores.links.getCurrent({ consumerCapsuleId: "consumer", requirementKey: "tools" });
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: current!.generation });
  const bindings = await f.service.listBindings(f.providers[0]!.metadata.id);
  expect(bindings.find((b) => b.metadata.id === previous.metadata.id)?.status.phase).toBe("Revoked");
  expect(bindings.filter((b) => b.status.phase === "Ready").map((b) => b.metadata.materializedFrom?.linkId)).toEqual([next.id]);
});

test("a failed old-grant cleanup after link replacement converges at next sign-in", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  const revoke = f.service.revokeBinding.bind(f.service);
  let failed = false;
  f.service.revokeBinding = async (...args) => { if (!failed) { failed = true; throw new Error("cleanup interrupted"); } return revoke(...args); };
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: old.generation })).rejects.toThrow("cleanup interrupted");
  f.service.revokeBinding = revoke;
  const next = await f.stores.links.getCurrent({ consumerCapsuleId: "consumer", requirementKey: "tools" });
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [f.state.requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => [b.metadata.materializedFrom?.linkId, b.spec.permissions])).toEqual([[next!.id, ["mcp.read"]]]);
});

test("a revoke that persists then throws still converges at next sign-in", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure("alice");
  const revoke = f.service.revokeBinding.bind(f.service);
  let failed = false;
  f.service.revokeBinding = async (...args) => { const result = await revoke(...args); if (!failed) { failed = true; throw new Error("projection interrupted"); } return result; };
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: old.generation })).rejects.toThrow("projection interrupted");
  f.service.revokeBinding = revoke;
  const next = await f.stores.links.getCurrent({ consumerCapsuleId: "consumer", requirementKey: "tools" });
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [f.state.requirement] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready").map((b) => [b.metadata.materializedFrom?.linkId, b.spec.permissions])).toEqual([[next!.id, ["mcp.read"]]]);
});

test("an explicitly revoked current-link grant remains denied after stale cleanup", async () => {
  const f = await fixture();
  const link = await f.link();
  await f.ensure("alice");
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  await f.service.revokeBinding(f.providers[0]!.metadata.id, binding.metadata.id);
  await f.ensure("alice");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready")).toHaveLength(0);
  expect((await f.stores.links.get(link.id))?.state).toBe("active");
});

test("an explicitly revoked linkId-less current grant remains denied", async () => {
  const f = await fixture();
  await f.link();
  await f.ensure("alice");
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const linkless = { ...binding, metadata: { ...binding.metadata, generation: binding.metadata.generation + 1, materializedFrom: { ...binding.metadata.materializedFrom!, linkId: undefined } } };
  expect(await f.stores.bindings.compareAndSet(linkless, binding.metadata.generation)).toBe(true);
  await f.service.revokeBinding(f.providers[0]!.metadata.id, binding.metadata.id);
  await f.ensure("alice");
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((b) => b.status.phase === "Ready")).toHaveLength(0);
});

test("legacy linkId-less grant retries narrowing after create fails following automatic revoke", async () => {
  const f = await fixture();
  await f.link();
  await f.ensure("alice");
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const linkless = { ...binding, metadata: { ...binding.metadata, generation: binding.metadata.generation + 1, materializedFrom: { ...binding.metadata.materializedFrom!, linkId: undefined } } };
  expect(await f.stores.bindings.compareAndSet(linkless, binding.metadata.generation)).toBe(true);
  const reduced = { ...requirement, permissions: ["mcp.read"] };
  const create = f.service.createBinding.bind(f.service);
  f.service.createBinding = async () => { throw new Error("transient create failure"); };
  await expect(f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [reduced] })).rejects.toThrow("transient create failure");
  f.service.createBinding = create;
  const revoked = (await f.service.listBindings(f.providers[0]!.metadata.id)).find((item) => item.metadata.id === binding.metadata.id)!;
  expect(revoked.status.phase).toBe("Revoked");
  expect(revoked.status.conditions?.[0]?.reason).toBe("Superseded");
  await f.service.ensureCapsuleRequiredInterfaces({ workspaceId: "ws", capsuleId: "consumer", principalId: "alice", requirements: [reduced] });
  expect((await f.service.listBindings(f.providers[0]!.metadata.id)).filter((item) => item.status.phase === "Ready").map((item) => [item.metadata.materializedFrom?.linkId, item.spec.permissions])).toEqual([[expect.any(String), ["mcp.read"]]]);
  await expect(f.service.issueToken(f.providers[0]!.metadata.id, { permission: "mcp.write" }, { workspaceId: "ws", subjectId: "alice" })).rejects.toThrow("grant not found");
});

test("same-provider version change revokes a linkId-less old grant before recreating it", async () => {
  const f = await fixture();
  const old = await f.link();
  await f.ensure();
  const binding = (await f.service.listBindings(f.providers[0]!.metadata.id))[0]!;
  const source = binding.metadata.materializedFrom;
  if (source?.source !== "capsule_required_interface") throw new Error("required grant expected");
  expect(await f.stores.bindings.compareAndSet({ ...binding, metadata: { ...binding.metadata, generation: binding.metadata.generation + 1, materializedFrom: { ...source, linkId: undefined } } }, binding.metadata.generation)).toBe(true);
  const iface = await f.service.get(f.providers[0]!.metadata.id);
  await f.service.update(iface.metadata.id, { spec: { ...iface.spec, version: "2" } }, iface.metadata.generation);
  f.state.requirement = { ...requirement, interface: { type: "mcp.server", version: "2" } };
  const next = await f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: iface.metadata.id, expectedGeneration: old.generation });
  expect(next.interface.version).toBe("2");
  const bindings = await f.service.listBindings(iface.metadata.id);
  expect(bindings.filter((item) => item.status.phase === "Ready").map((item) => item.metadata.materializedFrom)).toEqual([expect.objectContaining({ linkId: next.id, interfaceVersion: "2" })]);
  expect(bindings.find((item) => item.metadata.id === binding.metadata.id)?.status.phase).toBe("Revoked");
});

test("auto_single never selects a private Interface", async () => {
  const f = await fixture();
  const provider = f.providers[0]!;
  await f.service.update(provider.metadata.id, { spec: { ...provider.spec, access: { ...provider.spec.access, visibility: "private" } } }, provider.metadata.generation);
  await expect(f.service.ensureCapsuleInterfaceLinks({ workspaceId: "ws", capsuleId: "consumer", requirements: [requirement], selections: [{ requirementKey: "tools", interfaceId: provider.metadata.id, selection: "auto_single" }] })).rejects.toThrow("private Interface requires explicit selection");
  expect(await f.service.listCapsuleInterfaceLinks("consumer")).toHaveLength(0);
});

test("backfill PUT refuses a requirement changed since dry-run", async () => {
  const f = await fixture();
  const expectedRequirementFingerprint = await stableJsonDigest({ permissions: requirement.permissions, delivery: requirement.delivery });
  f.state.requirement = { ...requirement, permissions: ["mcp.read"] };
  await expect(f.service.putCapsuleInterfaceLink({ capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, expectedGeneration: 0, expectedRequirementFingerprint })).rejects.toThrow("changed since review");
  expect(await f.service.listCapsuleInterfaceLinks("consumer")).toHaveLength(0);
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

test("scheduled-uninstall providers are not candidates and destroyed consumers disappear from provider usage", async () => {
  const f = await fixture();
  const provider = f.capsules.get("provider_a")!;
  f.capsules.set("provider_a", { ...provider, status: "uninstalled" });
  expect((await f.service.listInterfaceLinkCandidates({ workspaceId: "ws", capsuleId: "consumer", requirement })).map((item) => item.metadata.ownerRef.id)).toEqual(["provider_b"]);
  f.capsules.set("provider_a", provider);
  await f.link();
  expect(await f.service.listProviderCapsuleInterfaceLinks("provider_a")).toHaveLength(1);
  f.capsules.set("consumer", { ...f.capsules.get("consumer")!, status: "destroyed" });
  expect(await f.service.listProviderCapsuleInterfaceLinks("provider_a")).toHaveLength(0);
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

test("a caller's per-request provider approval decides whether a new link is active", async () => {
  const f = await fixture();
  const providers: string[] = [];
  const refused = await f.service.ensureCapsuleInterfaceLinks({
    workspaceId: "ws", capsuleId: "consumer", requirements: [requirement],
    selections: [{ requirementKey: "tools", interfaceId: f.providers[0]!.metadata.id, selection: "explicit" }],
  }, { actorAccountId: "member", roles: [], requestId: "r1" }, {
    assertCurrent: async () => undefined,
    mayApproveProvider: async (provider) => { providers.push(`${provider.workspaceId}/${provider.capsuleId}`); return false; },
  });
  expect(refused[0]).toMatchObject({ state: "pending_approval", approvedPermissions: [] });
  expect(refused[0]!.approval).toBeUndefined();
  expect(providers).toEqual(["ws/provider_a"]);
  const approved = await f.service.putCapsuleInterfaceLink({
    capsuleId: "consumer", requirementKey: "tools", interfaceId: f.providers[1]!.metadata.id,
    expectedGeneration: refused[0]!.generation,
  }, { actorAccountId: "provider_manager", roles: [], requestId: "r2" }, {
    assertCurrent: async () => undefined,
    mayApproveProvider: async () => true,
  });
  expect(approved).toMatchObject({ state: "active", approval: { kind: "requester_manages_provider", approvedBy: "provider_manager" } });
});
