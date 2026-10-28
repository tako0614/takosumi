#!/usr/bin/env bun
/** Operator-run, API-fenced backfill of pre-link required Interface bindings. */
import type { Interface, InterfaceBinding, InterfaceLink } from "takosumi-contract/interfaces";

export interface LegacyLinkBackfillEntry {
  readonly workspaceId: string;
  readonly consumerCapsuleId: string;
  readonly requirementKey: string;
  readonly providerInterfaceId: string;
  readonly bindingIds: readonly string[];
}

export interface LegacyLinkBackfillOptions {
  readonly baseUrl: string;
  readonly workspaceIds: readonly string[];
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

async function getJson<T>(options: LegacyLinkBackfillOptions, path: string): Promise<T> {
  const response = await (options.fetcher ?? fetch)(new URL(path, options.baseUrl), {
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) throw new Error(`Interface-link backfill read failed: ${path} (${response.status})`);
  return await response.json() as T;
}

/** Dry-run inventory; it makes only GET requests and refuses ambiguous scopes. */
export async function planLegacyInterfaceLinkBackfill(options: LegacyLinkBackfillOptions): Promise<readonly LegacyLinkBackfillEntry[]> {
  const scopes = new Map<string, LegacyLinkBackfillEntry>();
  for (const workspaceId of options.workspaceIds) {
    const listed = await getJson<{ interfaces: Interface[] }>(options, `/api/v1/interfaces?workspaceId=${encodeURIComponent(workspaceId)}&ownerKind=Capsule&includeRetired=true`);
    for (const iface of listed.interfaces) {
      if (iface.metadata.workspaceId !== workspaceId || iface.metadata.ownerRef.kind !== "Capsule") throw new Error("Interface inventory escaped its Workspace or Capsule scope");
      const result = await getJson<{ bindings: InterfaceBinding[] }>(options, `/api/v1/interfaces/${encodeURIComponent(iface.metadata.id)}/bindings`);
      for (const binding of result.bindings) {
        const source = binding.metadata.materializedFrom;
        if (source?.source !== "capsule_required_interface" || source.linkId || binding.status.phase === "Revoked" || binding.spec.subjectRef.kind !== "Principal") continue;
        if (binding.spec.interfaceId !== iface.metadata.id || binding.metadata.workspaceId !== workspaceId || source.interfaceType !== iface.spec.type || source.interfaceVersion !== iface.spec.version) throw new Error(`Legacy binding ${binding.metadata.id} does not match its Interface`);
        const scope = `${workspaceId}\0${source.capsuleId}\0${source.requirementKey}`;
        const prior = scopes.get(scope);
        if (prior && prior.providerInterfaceId !== iface.metadata.id) throw new Error(`Ambiguous legacy providers for ${source.capsuleId}/${source.requirementKey}`);
        scopes.set(scope, { workspaceId, consumerCapsuleId: source.capsuleId, requirementKey: source.requirementKey, providerInterfaceId: iface.metadata.id, bindingIds: [...(prior?.bindingIds ?? []), binding.metadata.id] });
      }
    }
  }
  const entries = [...scopes.values()].sort((a, b) => `${a.workspaceId}/${a.consumerCapsuleId}/${a.requirementKey}`.localeCompare(`${b.workspaceId}/${b.consumerCapsuleId}/${b.requirementKey}`));
  for (const entry of entries) {
    const view = await getJson<{ generation: number; candidates: { interfaceId: string }[] }>(options, `/api/v1/capsules/${encodeURIComponent(entry.consumerCapsuleId)}/interface-links/${encodeURIComponent(entry.requirementKey)}/candidates`);
    if (view.generation !== 0) throw new Error(`Existing Interface-link lineage requires manual review: ${entry.consumerCapsuleId}/${entry.requirementKey}`);
    if (!view.candidates.some((candidate) => candidate.interfaceId === entry.providerInterfaceId)) throw new Error(`Legacy provider is no longer a candidate: ${entry.consumerCapsuleId}/${entry.requirementKey}`);
  }
  return entries;
}

/** Every write is an ordinary authorized PUT with expectedGeneration=0. */
export async function applyLegacyInterfaceLinkBackfill(options: LegacyLinkBackfillOptions, plan: readonly LegacyLinkBackfillEntry[]): Promise<readonly InterfaceLink[]> {
  const applied: InterfaceLink[] = [];
  for (const entry of plan) {
    const path = `/api/v1/capsules/${encodeURIComponent(entry.consumerCapsuleId)}/interface-links/${encodeURIComponent(entry.requirementKey)}`;
    const response = await (options.fetcher ?? fetch)(new URL(path, options.baseUrl), {
      method: "PUT",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ interfaceId: entry.providerInterfaceId, expectedGeneration: 0 }),
    });
    if (!response.ok) throw new Error(`Interface-link backfill stopped after ${applied.length} writes: ${path} (${response.status})`);
    const result = await response.json() as { link: InterfaceLink };
    if (result.link.state !== "active" || result.link.providerInterfaceId !== entry.providerInterfaceId || result.link.consumerCapsuleId !== entry.consumerCapsuleId || result.link.requirementKey !== entry.requirementKey) throw new Error(`Interface-link backfill returned unexpected authority after ${applied.length + 1} writes: ${path}`);
    applied.push(result.link);
  }
  return applied;
}

async function main(args: readonly string[]): Promise<void> {
  const workspaceIds: string[] = [];
  let baseUrl = process.env.TAKOSUMI_CONTROL_API_URL;
  let apply = false;
  for (const arg of args) {
    if (arg.startsWith("--workspace=")) workspaceIds.push(arg.slice("--workspace=".length));
    else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!baseUrl || workspaceIds.length === 0 || workspaceIds.some((id) => !id.trim())) throw new Error("Use --base-url=<Control API URL> and one or more --workspace=<id>");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") throw new Error("Control API must use HTTPS except on localhost");
  const token = process.env.TAKOSUMI_CONTROL_TOKEN;
  if (!token) throw new Error("TAKOSUMI_CONTROL_TOKEN is required");
  const options = { baseUrl: parsed.href, workspaceIds, token };
  const plan = await planLegacyInterfaceLinkBackfill(options);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", entries: plan }, null, 2));
  if (apply) console.log(JSON.stringify({ applied: (await applyLegacyInterfaceLinkBackfill(options, plan)).length }));
}

if (import.meta.main) await main(process.argv.slice(2));
