import { Command } from "../command.ts";
import { ARTIFACTS_BASE_PATH } from "takosumi-contract/reference/runtime-agent-lifecycle";
import { loadConfig, resolveMode } from "../config.ts";
import { exitCli, readFile } from "../runtime.ts";

/**
 * `takosumi artifact push <file> --kind <kind>` — upload a file to the
 * Takosumi service's content-addressed artifact store and print the resulting hash.
 * This is an optional operator data-asset store; the installer does not require
 * artifact kinds.
 */

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function createPushCmd(): Command {
  return new Command("push")
    .description("Upload a file as a content-addressed artifact")
    .argument("<file>", "File to upload")
    .requiredOption("--kind <kind>", "Operator-defined artifact kind")
    .option(
      "--metadata <kv>",
      "Metadata as key=value (repeat for multiple)",
      collect,
      [],
    )
    .option("--remote <url>", "Takosumi service base URL")
    .option("--token <token>", "Bearer token")
    .action(
      async (
        filePath: string,
        opts: {
          kind: string;
          metadata: string[];
          remote?: string;
          token?: string;
        },
      ) => {
        const target = await requireRemote(opts.remote, opts.token);
        const bytes = await readFile(filePath);
        const meta = parseMetadata(opts.metadata);
        const form = new FormData();
        form.set("kind", opts.kind);
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
          console.error(`Takosumi service ${response.status}:`, body);
          exitCli(1);
        }
        console.log(JSON.stringify(body, null, 2));
      },
    ) as Command;
}

function createListCmd(): Command {
  return new Command("list")
    .description("List artifacts stored in the Takosumi service")
    .option("--remote <url>", "Takosumi service base URL")
    .option("--token <token>", "Bearer token")
    .option(
      "--limit <n>",
      "Per-page limit; CLI follows pagination automatically",
      (v) => Number(v),
    )
    .action(
      async (opts: { remote?: string; token?: string; limit?: number }) => {
        const target = await requireRemote(opts.remote, opts.token);
        interface ListPage {
          readonly artifacts?: readonly unknown[];
          readonly nextCursor?: string;
        }
        const allArtifacts: unknown[] = [];
        let cursor: string | undefined;
        const pageLimit = typeof opts.limit === "number" && opts.limit > 0
          ? opts.limit
          : 100;
        // The service endpoint enforces 1..1000; we just walk pages until
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
            console.error(`Takosumi service ${response.status}:`, body);
            exitCli(1);
          }
          const page = Array.isArray(body?.artifacts) ? body.artifacts : [];
          for (const a of page) allArtifacts.push(a);
          if (!body?.nextCursor) break;
          cursor = body.nextCursor;
        }
        console.log(JSON.stringify({ artifacts: allArtifacts }, null, 2));
      },
    ) as Command;
}

function createRmCmd(): Command {
  return new Command("rm")
    .description("Remove an artifact by hash")
    .argument("<hash>", "Artifact hash")
    .option("--remote <url>", "Takosumi service base URL")
    .option("--token <token>", "Bearer token")
    .action(
      async (hash: string, opts: { remote?: string; token?: string }) => {
        const target = await requireRemote(opts.remote, opts.token);
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
        console.error(`Takosumi service ${response.status}:`, body);
        exitCli(1);
      },
    ) as Command;
}

function createKindsCmd(): Command {
  return new Command("kinds")
    .description(
      "List DataAsset metadata kinds registered by the optional DataAsset " +
        "extension (GET /v1/artifacts/kinds)",
    )
    .option("--remote <url>", "Takosumi service base URL")
    .option("--token <token>", "Bearer token")
    .option("--table", "Format output as a plain-text table instead of JSON")
    .action(
      async (opts: { remote?: string; token?: string; table?: boolean }) => {
        const target = await requireRemote(opts.remote, opts.token);
        const response = await fetch(
          `${target.url}${ARTIFACTS_BASE_PATH}/kinds`,
          {
            headers: { authorization: `Bearer ${target.token}` },
          },
        );
        const body = await readBody(response) as
          | { readonly kinds?: readonly RegisteredArtifactKindRow[] }
          | undefined;
        if (!response.ok) {
          console.error(`Takosumi service ${response.status}:`, body);
          exitCli(1);
        }
        const kinds = body?.kinds ?? [];
        if (opts.table) {
          printKindsTable(kinds);
          return;
        }
        console.log(JSON.stringify({ kinds }, null, 2));
      },
    ) as Command;
}

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

function createGcCmd(): Command {
  return new Command("gc")
    .description(
      "Garbage-collect artifacts not referenced by any persisted deployment",
    )
    .option("--remote <url>", "Takosumi service base URL")
    .option("--token <token>", "Bearer token")
    .option(
      "--dry-run",
      "Report what would be deleted without actually deleting",
    )
    .action(
      async (opts: { remote?: string; token?: string; dryRun?: boolean }) => {
        const target = await requireRemote(opts.remote, opts.token);
        const url = new URL(`${target.url}${ARTIFACTS_BASE_PATH}/gc`);
        if (opts.dryRun) url.searchParams.set("dryRun", "1");
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${target.token}` },
        });
        const body = await readBody(response);
        if (!response.ok) {
          console.error(`Takosumi service ${response.status}:`, body);
          exitCli(1);
        }
        console.log(JSON.stringify(body, null, 2));
      },
    ) as Command;
}

// Build every subcommand fresh per call. The CLI tests re-import this module
// (`?<uuid>`) and expect an independent command tree each time; under one bun
// process the module is shared, so module-level subcommand singletons would be
// added to multiple parents and commander would corrupt their parse state
// (a child's `.parent` is mutated by `addCommand`). Constructing children here
// keeps each `artifactCommand` self-contained.
function createArtifactCommand(): Command {
  const command = new Command("artifact")
    .description(
      "Manage Takosumi service artifact uploads (push / list / rm / gc / kinds)",
    );
  command.addCommand(createPushCmd());
  command.addCommand(createListCmd());
  command.addCommand(createRmCmd());
  command.addCommand(createGcCmd());
  command.addCommand(createKindsCmd());
  return command;
}

export const artifactCommand: Command = createArtifactCommand();

interface RemoteTarget {
  readonly url: string;
  readonly token: string;
}

async function requireRemote(
  remote?: string,
  token?: string,
): Promise<RemoteTarget> {
  const target = resolveMode(
    { remote, token },
    await loadConfig({ tokenEnv: "deploy" }),
  );
  if (target.mode !== "remote" || !target.url || !target.token) {
    console.error(
      "artifact commands require a remote Takosumi service: pass --remote and --token, " +
        "or set TAKOSUMI_REMOTE_URL + TAKOSUMI_DEPLOY_TOKEN",
    );
    exitCli(2);
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
      exitCli(2);
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
