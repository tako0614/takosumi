/**
 * Operator execution of a Capsule's typed `resource_migration` actions.
 *
 * The operator's job here is only to carry bytes, never to decide what they
 * mean. It reads the bundle manifest out of the Capsule's own source snapshot,
 * fetches the SQL the manifest names from the npm package the manifest pins,
 * and hands both to Takosumi. Every digest is re-derived server-side against
 * the Plan-pinned declaration, so a wrong or tampered fetch is rejected there
 * rather than trusted here.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

export interface ResourceMigrationAction {
  readonly kind: "resource_migration";
  readonly id: string;
  readonly target: { readonly resourceAddress: string };
  readonly bundle: {
    readonly format: string;
    readonly manifestPath: string;
    readonly digest: string;
  };
}

export interface ResourceMigrationBundleSource {
  readonly kind: "npm";
  readonly package: string;
  readonly version: string;
  readonly path: string;
}

export interface ResourceMigrationManifest {
  readonly apiVersion: string;
  readonly source: ResourceMigrationBundleSource;
  readonly entries: readonly { readonly name: string }[];
}

export interface ResourceMigrationRequest {
  readonly actionId: string;
  readonly manifest: string;
  readonly entries: readonly { readonly name: string; readonly sql: string }[];
}

/** Guards against a manifest naming its way out of the extracted snapshot. */
function assertContainedPath(root: string, candidate: string): string {
  const resolved = normalize(join(root, candidate));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `resource migration bundle path ${candidate} escapes the source snapshot`,
    );
  }
  return resolved;
}

export function parseResourceMigrationManifest(
  manifestText: string,
): ResourceMigrationManifest {
  const parsed = JSON.parse(manifestText) as ResourceMigrationManifest;
  if (parsed?.apiVersion !== "takosumi.resource-migrations/v1") {
    throw new Error("resource migration manifest apiVersion is unsupported");
  }
  if (parsed.source?.kind !== "npm") {
    throw new Error(
      `resource migration bundle source ${parsed.source?.kind} is unsupported`,
    );
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error("resource migration manifest declares no entries");
  }
  return parsed;
}

/**
 * Builds the request for one declaration: the manifest verbatim (its byte
 * identity is what the pin is over, so it is never re-serialized) plus one SQL
 * body per named entry.
 */
export async function buildResourceMigrationRequest(input: {
  readonly action: ResourceMigrationAction;
  readonly sourceRoot: string;
  readonly readPackageFile: (
    source: ResourceMigrationBundleSource,
    entryName: string,
  ) => Promise<string>;
}): Promise<ResourceMigrationRequest> {
  if (input.action.bundle.format !== "takosumi.resource-migrations/v1") {
    throw new Error(
      `resource migration bundle format ${input.action.bundle.format} is unsupported`,
    );
  }
  const manifestPath = assertContainedPath(
    input.sourceRoot,
    input.action.bundle.manifestPath,
  );
  const manifest = await readFile(manifestPath, "utf8");
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  if (digest !== input.action.bundle.digest) {
    // Failing here rather than at the server keeps the operator's own message
    // about the thing it can actually fix: a stale checkout.
    throw new Error(
      `resource migration manifest ${input.action.bundle.manifestPath} does not match the Plan-pinned digest`,
    );
  }
  const parsed = parseResourceMigrationManifest(manifest);
  const entries = [];
  for (const entry of parsed.entries) {
    entries.push({
      name: entry.name,
      sql: await input.readPackageFile(parsed.source, entry.name),
    });
  }
  return { actionId: input.action.id, manifest, entries };
}

export function resourceMigrationEndpoint(
  apiBase: string,
  capsuleId: string,
): string {
  return new URL(
    `/internal/v1/capsules/${encodeURIComponent(capsuleId)}/resource-migrations`,
    apiBase,
  ).toString();
}

export async function submitResourceMigration(input: {
  readonly apiBase: string;
  readonly token: string;
  readonly capsuleId: string;
  readonly request: ResourceMigrationRequest;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly applied: readonly string[]; readonly skipped: readonly string[] }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    resourceMigrationEndpoint(input.apiBase, input.capsuleId),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.request),
    },
  );
  const body = (await response.json().catch(() => undefined)) as
    | {
        readonly applied?: readonly string[];
        readonly skipped?: readonly string[];
        readonly message?: unknown;
      }
    | undefined;
  if (!response.ok) {
    throw new Error(
      `resource migration ${input.request.actionId} failed with ${response.status}: ${
        typeof body?.message === "string" ? body.message : "no detail"
      }`,
    );
  }
  return {
    applied: body?.applied ?? [],
    skipped: body?.skipped ?? [],
  };
}
