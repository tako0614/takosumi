#!/usr/bin/env bun
/** TASK-0118 operator CLI. Dry-run unless both --apply and a report digest are supplied. */
import { SOURCE_OWNERSHIP_MIGRATION_PATH } from "../worker/src/source_ownership_migration_operator.ts";

interface Options {
  readonly baseUrl: string;
  readonly sourceId?: string;
  readonly apply: boolean;
  readonly reportDigest?: string;
  readonly preparedAt?: string;
}

function usage(): string {
  return [
    "usage: bun scripts/operator-source-ownership.ts --base-url URL [--source-id ID]",
    "       bun scripts/operator-source-ownership.ts --base-url URL --source-id ID --apply --prepared-at ISO_UTC --report-digest sha256:HEX",
    "Environment: TAKOSUMI_DEPLOY_CONTROL_TOKEN (operator bearer).",
    "Default: read-only inventory. Apply changes only one reviewed Source group.",
  ].join("\n");
}

function parse(argv: readonly string[]): Options {
  if (argv.includes("--help")) { console.log(usage()); process.exit(0); }
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") { apply = true; continue; }
    if (!new Set(["--base-url", "--source-id", "--report-digest", "--prepared-at"]).has(arg) || values.has(arg)) {
      throw new Error(`invalid argument: ${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  }
  const baseUrl = values.get("--base-url");
  const sourceId = values.get("--source-id");
  const reportDigest = values.get("--report-digest");
  const preparedAt = values.get("--prepared-at");
  if (!baseUrl) throw new Error("--base-url is required");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("--base-url must be HTTPS or local loopback HTTP");
  }
  if (sourceId && !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/.test(sourceId)) throw new Error("invalid --source-id");
  if (apply && (!sourceId || !preparedAt || !Number.isFinite(Date.parse(preparedAt)) ||
    new Date(preparedAt).toISOString() !== preparedAt || !reportDigest || !/^sha256:[0-9a-f]{64}$/.test(reportDigest))) {
    throw new Error("--apply requires --source-id, --prepared-at and exact --report-digest from the dry-run");
  }
  if (!apply && (reportDigest || preparedAt)) throw new Error("--prepared-at and --report-digest are only valid with --apply");
  return { baseUrl: url.origin, sourceId, apply, preparedAt, reportDigest };
}

export async function runOperatorSourceOwnership(
  options: Options,
  token: string,
  request: typeof fetch = fetch,
): Promise<{ readonly status: number; readonly body: unknown }> {
  if (!token) throw new Error("TAKOSUMI_DEPLOY_CONTROL_TOKEN is required");
  const url = new URL(SOURCE_OWNERSHIP_MIGRATION_PATH, options.baseUrl);
  if (!options.apply && options.sourceId) url.searchParams.set("sourceId", options.sourceId);
  let copyCursor = 0;
  let copyReceipt: string | undefined;
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const response = await request(url, {
      method: options.apply ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(options.apply ? { "content-type": "application/json" } : {}) },
      ...(options.apply ? { body: JSON.stringify({ sourceId: options.sourceId,
        preparedAt: options.preparedAt, reportDigest: options.reportDigest,
        ...(copyCursor > 0 ? { copyCursor, copyReceipt } : {}) }) } : {}),
    });
    const body = await response.json().catch(() => ({ error: "invalid_operator_response" }));
    if (!options.apply || response.status !== 202) return { status: response.status, body };
    const pending = body as { nextCopyCursor?: unknown; copyReceipt?: unknown; copiesTotal?: unknown };
    if (!Number.isSafeInteger(pending.nextCopyCursor) || (pending.nextCopyCursor as number) <= copyCursor ||
      !Number.isSafeInteger(pending.copiesTotal) || (pending.nextCopyCursor as number) > (pending.copiesTotal as number) ||
      typeof pending.copyReceipt !== "string" || !/^[0-9a-f]{64}$/.test(pending.copyReceipt)) {
      throw new Error("invalid_operator_copy_progress");
    }
    copyCursor = pending.nextCopyCursor as number;
    copyReceipt = pending.copyReceipt;
  }
  throw new Error("operator_copy_progress_limit_exceeded");
}

if (import.meta.main) {
  try {
    const options = parse(process.argv.slice(2));
    const result = await runOperatorSourceOwnership(options, process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN ?? "");
    console.log(JSON.stringify(result.body, null, 2));
    if (result.status >= 400) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "operator_source_ownership_failed");
    console.error(usage());
    process.exitCode = 1;
  }
}
