#!/usr/bin/env bun
/** TASK-0118 operator CLI. Dry-run unless both --apply and a report digest are supplied. */
import {
  SOURCE_OWNERSHIP_MIGRATION_PATH,
  SOURCE_OWNERSHIP_MIGRATION_SOURCE_ID,
} from "../worker/src/source_ownership_migration_operator.ts";

interface Options {
  readonly baseUrl: string;
  readonly sourceId?: string;
  readonly apply: boolean;
  readonly inventory?: boolean;
  readonly reportDigest?: string;
  readonly preparedAt?: string;
}

function usage(): string {
  return [
    "usage: bun scripts/operator-source-ownership.ts --base-url URL [--source-id ID]",
    "       bun scripts/operator-source-ownership.ts --base-url URL --inventory",
    "       bun scripts/operator-source-ownership.ts --base-url URL --source-id ID --apply --prepared-at ISO_UTC --report-digest sha256:HEX",
    "Environment: TAKOSUMI_DEPLOY_CONTROL_TOKEN (operator bearer).",
    "Default: read-only inventory. Apply changes only one reviewed Source group.",
    "--inventory reads one Source group per request and retains its exact dry-run receipt.",
  ].join("\n");
}

function parse(argv: readonly string[]): Options {
  if (argv.includes("--help")) { console.log(usage()); process.exit(0); }
  const values = new Map<string, string>();
  let apply = false;
  let inventory = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--inventory") { inventory = true; continue; }
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
  if (sourceId && !SOURCE_OWNERSHIP_MIGRATION_SOURCE_ID.test(sourceId)) throw new Error("invalid --source-id");
  if (inventory && (sourceId || apply)) throw new Error("--inventory cannot be combined with --source-id or --apply");
  if (apply && (!sourceId || !preparedAt || !Number.isFinite(Date.parse(preparedAt)) ||
    new Date(preparedAt).toISOString() !== preparedAt || !reportDigest || !/^sha256:[0-9a-f]{64}$/.test(reportDigest))) {
    throw new Error("--apply requires --source-id, --prepared-at and exact --report-digest from the dry-run");
  }
  if (!apply && (reportDigest || preparedAt)) throw new Error("--prepared-at and --report-digest are only valid with --apply");
  return { baseUrl: url.origin, sourceId, apply, inventory, preparedAt, reportDigest };
}

async function readInventory(url: URL, token: string, request: typeof fetch) {
  url.searchParams.set("inventoryPage", "1");
  const reports: unknown[] = [];
  let after = "";
  for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
    const response = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => null) as {
      kind?: string;
      nextAfterSourceId?: string | null;
      report?: {
        kind?: string;
        preparedAt?: string;
        reportDigest?: string;
        results?: Array<{ inventory?: { sourceId?: unknown } }>;
      } | null;
    } | null;
    if (response.status !== 200) return { status: response.status, body };
    if (body?.kind !== "takosumi.source-ownership-migration.inventory-page@v1") {
      throw new Error("invalid_operator_inventory_page");
    }
    const report = body.report;
    if (report !== null) {
      const sourceId = report?.results?.[0]?.inventory?.sourceId;
      if (report?.kind !== "takosumi.source-ownership-migration.dry-run@v1" ||
        !Array.isArray(report.results) || report.results.length !== 1 ||
        typeof sourceId !== "string" || !SOURCE_OWNERSHIP_MIGRATION_SOURCE_ID.test(sourceId) || sourceId <= after ||
        typeof report.preparedAt !== "string" || !Number.isFinite(Date.parse(report.preparedAt)) ||
        typeof report.reportDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(report.reportDigest) ||
        (body.nextAfterSourceId !== null && body.nextAfterSourceId !== sourceId)) {
        throw new Error("invalid_operator_inventory_page");
      }
      reports.push(report);
      after = sourceId;
    } else if (body.nextAfterSourceId !== null) {
      throw new Error("invalid_operator_inventory_page");
    }
    if (body.nextAfterSourceId === null) {
      return { status: 200, body: { kind: "takosumi.source-ownership-migration.inventory@v1", reports } };
    }
    url.searchParams.set("afterSourceId", after);
  }
  throw new Error("operator_inventory_page_limit_exceeded");
}

export async function runOperatorSourceOwnership(
  options: Options,
  token: string,
  request: typeof fetch = fetch,
): Promise<{ readonly status: number; readonly body: unknown }> {
  if (!token) throw new Error("TAKOSUMI_DEPLOY_CONTROL_TOKEN is required");
  const url = new URL(SOURCE_OWNERSHIP_MIGRATION_PATH, options.baseUrl);
  if (options.inventory) {
    if (options.apply || options.sourceId) throw new Error("invalid_operator_inventory_options");
    return readInventory(url, token, request);
  }
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
