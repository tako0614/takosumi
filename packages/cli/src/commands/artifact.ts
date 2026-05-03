import { Command } from "@cliffy/command";
import { ARTIFACTS_BASE_PATH } from "takosumi-contract";
import { loadConfig, resolveMode } from "../config.ts";

/**
 * `takosumi artifact push <file> --kind <kind>` — upload a file to the
 * kernel's content-addressed artifact store and print the resulting hash. The
 * operator typically embeds the printed hash into a manifest under
 * `artifact: { kind, hash }` and then runs `takosumi deploy`.
 */

const pushCmd = new Command()
  .description("Upload a file as a content-addressed artifact")
  .arguments("<file:string>")
  .option(
    "--kind <kind:string>",
    "Artifact kind (e.g. js-bundle, lambda-zip, oci-image)",
    { required: true },
  )
  .option(
    "--metadata <kv:string>",
    "Metadata as key=value (repeat for multiple)",
    { collect: true },
  )
  .option("--remote <url:string>", "Kernel base URL")
  .option("--token <token:string>", "Bearer token")
  .action(async ({ kind, metadata, remote, token }, filePath: string) => {
    const target = await requireRemote(remote, token);
    const bytes = await Deno.readFile(filePath);
    const meta = parseMetadata(metadata);
    const form = new FormData();
    form.set("kind", kind);
    if (meta) form.set("metadata", JSON.stringify(meta));
    form.set(
      "body",
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
      baseName(filePath),
    );
    const response = await fetch(`${target.url}${ARTIFACTS_BASE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
      body: form,
    });
    const body = await readBody(response);
    if (!response.ok) {
      console.error(`kernel ${response.status}:`, body);
      Deno.exit(1);
    }
    console.log(JSON.stringify(body, null, 2));
  });

const listCmd = new Command()
  .description("List artifacts stored in the kernel")
  .option("--remote <url:string>", "Kernel base URL")
  .option("--token <token:string>", "Bearer token")
  .option(
    "--limit <n:number>",
    "Per-page limit; CLI follows pagination automatically",
  )
  .action(async ({ remote, token, limit }) => {
    const target = await requireRemote(remote, token);
    interface ListPage {
      readonly artifacts?: readonly unknown[];
      readonly nextCursor?: string;
    }
    const allArtifacts: unknown[] = [];
    let cursor: string | undefined;
    const pageLimit = typeof limit === "number" && limit > 0 ? limit : 100;
    // The kernel endpoint enforces 1..1000; we just walk pages until
    // nextCursor disappears or we exceed a sane upper bound.
    for (let pages = 0; pages < 10_000; pages++) {
      const url = new URL(`${target.url}${ARTIFACTS_BASE_PATH}`);
      url.searchParams.set("limit", String(pageLimit));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${target.token}` },
      });
      const body = await readBody(response) as ListPage;
      if (!response.ok) {
        console.error(`kernel ${response.status}:`, body);
        Deno.exit(1);
      }
      const page = Array.isArray(body?.artifacts) ? body.artifacts : [];
      for (const a of page) allArtifacts.push(a);
      if (!body?.nextCursor) break;
      cursor = body.nextCursor;
    }
    console.log(JSON.stringify({ artifacts: allArtifacts }, null, 2));
  });

const rmCmd = new Command()
  .description("Remove an artifact by hash")
  .arguments("<hash:string>")
  .option("--remote <url:string>", "Kernel base URL")
  .option("--token <token:string>", "Bearer token")
  .action(async ({ remote, token }, hash: string) => {
    const target = await requireRemote(remote, token);
    const response = await fetch(
      `${target.url}${ARTIFACTS_BASE_PATH}/${encodeURIComponent(hash)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${target.token}` },
      },
    );
    if (response.status === 204) {
      console.log(`removed ${hash}`);
      return;
    }
    const body = await readBody(response);
    console.error(`kernel ${response.status}:`, body);
    Deno.exit(1);
  });

const kindsCmd = new Command()
  .description(
    "List the artifact kinds the deployed kernel understands " +
      "(GET /v1/artifacts/kinds)",
  )
  .option("--remote <url:string>", "Kernel base URL")
  .option("--token <token:string>", "Bearer token")
  .option("--table", "Format output as a plain-text table instead of JSON")
  .action(async ({ remote, token, table }) => {
    const target = await requireRemote(remote, token);
    const response = await fetch(`${target.url}${ARTIFACTS_BASE_PATH}/kinds`, {
      headers: { authorization: `Bearer ${target.token}` },
    });
    const body = await readBody(response) as
      | { readonly kinds?: readonly RegisteredArtifactKindRow[] }
      | undefined;
    if (!response.ok) {
      console.error(`kernel ${response.status}:`, body);
      Deno.exit(1);
    }
    const kinds = body?.kinds ?? [];
    if (table) {
      printKindsTable(kinds);
      return;
    }
    console.log(JSON.stringify({ kinds }, null, 2));
  });

interface RegisteredArtifactKindRow {
  readonly kind: string;
  readonly description: string;
  readonly contentTypeHint?: string;
  readonly maxSize?: number;
}

function printKindsTable(rows: readonly RegisteredArtifactKindRow[]): void {
  if (rows.length === 0) {
    console.log("(no artifact kinds registered)");
    return;
  }
  const widths = {
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
    contentType: Math.max(
      12,
      ...rows.map((r) => (r.contentTypeHint ?? "-").length),
    ),
    maxSize: Math.max(
      8,
      ...rows.map((r) =>
        (r.maxSize !== undefined ? String(r.maxSize) : "-")
          .length
      ),
    ),
  };
  const pad = (value: string, width: number) =>
    value + " ".repeat(Math.max(0, width - value.length));
  const header = `${pad("kind", widths.kind)}  ${
    pad("content-type", widths.contentType)
  }  ${pad("max-size", widths.maxSize)}  description`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      `${pad(row.kind, widths.kind)}  ${
        pad(row.contentTypeHint ?? "-", widths.contentType)
      }  ${
        pad(
          row.maxSize !== undefined ? String(row.maxSize) : "-",
          widths.maxSize,
        )
      }  ${row.description}`,
    );
  }
}

const gcCmd = new Command()
  .description(
    "Garbage-collect artifacts not referenced by any persisted deployment",
  )
  .option("--remote <url:string>", "Kernel base URL")
  .option("--token <token:string>", "Bearer token")
  .option(
    "--dry-run",
    "Report what would be deleted without actually deleting",
  )
  .action(async ({ remote, token, dryRun }) => {
    const target = await requireRemote(remote, token);
    const url = new URL(`${target.url}${ARTIFACTS_BASE_PATH}/gc`);
    if (dryRun) url.searchParams.set("dryRun", "1");
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
    });
    const body = await readBody(response);
    if (!response.ok) {
      console.error(`kernel ${response.status}:`, body);
      Deno.exit(1);
    }
    console.log(JSON.stringify(body, null, 2));
  });

export const artifactCommand = new Command()
  .description(
    "Manage Takosumi-kernel artifact uploads (push / list / rm / gc / kinds)",
  )
  .command("push", pushCmd)
  .command("list", listCmd)
  .command("rm", rmCmd)
  .command("gc", gcCmd)
  .command("kinds", kindsCmd);

interface RemoteTarget {
  readonly url: string;
  readonly token: string;
}

async function requireRemote(
  remote?: string,
  token?: string,
): Promise<RemoteTarget> {
  const target = resolveMode({ remote, token }, await loadConfig());
  if (target.mode !== "remote" || !target.url || !target.token) {
    console.error(
      "artifact commands require a remote kernel: pass --remote and --token, " +
        "or set TAKOSUMI_KERNEL_URL + TAKOSUMI_TOKEN",
    );
    Deno.exit(2);
  }
  return { url: target.url, token: target.token };
}

function parseMetadata(
  values: string[] | undefined,
): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of values) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      console.error(`invalid --metadata entry "${entry}" (expected key=value)`);
      Deno.exit(2);
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
