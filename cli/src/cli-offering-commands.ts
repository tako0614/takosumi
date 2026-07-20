import { readFile } from "node:fs/promises";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import { offeringCatalogsHelpText } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import {
  booleanOption,
  optionalIntegerOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

type Options = Record<string, string | boolean>;

export async function runOfferingCatalogs(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    io.stdout(offeringCatalogsHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "list":
        return await list(rest, io);
      case "get":
        return await get(rest, io);
      case "publish":
        return await publish(rest, io);
      case "availability":
        return await availability(rest, io);
      case "resolve":
        return await resolve(rest, io);
      default:
        io.stderr(`Unknown offering-catalogs command: ${command}`);
        io.stderr(offeringCatalogsHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

async function list(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const query = new URLSearchParams();
  const limit = optionalIntegerOption(options, "limit");
  const cursor = optionalStringOption(options, "cursor");
  if (limit !== undefined) query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  const response = await requestDeployControlApi({
    path: `/v1/offering-catalogs${query.size > 0 ? `?${query}` : ""}`,
    options,
  });
  io.stdout(formatCatalogList(response, booleanOption(options, "json")));
  return 0;
}

async function get(args: string[], io: CliIo): Promise<number> {
  const [catalogId, catalogVersion, ...optionArgs] = args;
  requireIdentity(catalogId, "Offering catalog id");
  requireIdentity(catalogVersion, "Offering catalog version");
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: catalogPath(catalogId, catalogVersion),
    options,
  });
  io.stdout(formatCatalog(response, booleanOption(options, "json")));
  return 0;
}

async function publish(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: "/v1/offering-catalogs",
    method: "POST",
    body: await readRequest(options),
    options,
  });
  io.stdout(formatCatalog(response, booleanOption(options, "json")));
  return 0;
}

async function availability(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: "/v1/offering-availability/query",
    method: "POST",
    body: await readRequest(options),
    options,
  });
  io.stdout(formatAvailability(response, booleanOption(options, "json")));
  return 0;
}

async function resolve(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: "/v1/offering-selections/resolve",
    method: "POST",
    body: await readRequest(options),
    options,
  });
  io.stdout(formatSelection(response, booleanOption(options, "json")));
  return 0;
}

async function readRequest(options: Options): Promise<Record<string, unknown>> {
  const path = optionalStringOption(options, "file");
  if (!path) throw new TypeError("--file is required");
  const value = parseJson(await readFile(path, "utf8"));
  if (!isRecord(value)) {
    throw new TypeError("--file must contain a JSON object");
  }
  return value;
}

function catalogPath(catalogId: string, catalogVersion: string): string {
  return `/v1/offering-catalogs/${encodeURIComponent(catalogId)}/versions/${encodeURIComponent(catalogVersion)}`;
}

function requireIdentity(
  value: string | undefined,
  label: string,
): asserts value is string {
  if (!value || value.startsWith("--"))
    throw new TypeError(`${label} is required`);
}

function formatCatalogList(value: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(value, null, 2);
  const catalogs =
    isRecord(value) && Array.isArray(value.catalogs) ? value.catalogs : [];
  if (catalogs.length === 0) return "No Offering catalogs found.";
  return [
    "Offering catalogs:",
    ...catalogs.map((catalog) => `  ${catalogSummary(catalog)}`),
    `${catalogs.length} catalog(s)`,
  ].join("\n");
}

function formatCatalog(value: unknown, asJson: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : catalogSummary(value);
}

function catalogSummary(value: unknown): string {
  if (!isRecord(value)) return "Invalid Offering catalog response";
  const offerings = Array.isArray(value.offerings) ? value.offerings : [];
  return `${stringValue(value.id) ?? "unknown"}@${stringValue(value.version) ?? "unknown"}  ${offerings.length} offering(s)  effective ${stringValue(value.effectiveAt) ?? "unknown"}`;
}

function formatAvailability(value: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(value, null, 2);
  const entries =
    isRecord(value) && Array.isArray(value.availability)
      ? value.availability
      : [];
  if (entries.length === 0) return "No Offerings found in the exact catalog.";
  return [
    "Offering availability:",
    ...entries.map((entry) => `  ${availabilitySummary(entry)}`),
  ].join("\n");
}

function availabilitySummary(value: unknown): string {
  if (!isRecord(value)) return "Invalid Offering availability response";
  const reference = isRecord(value.reference) ? value.reference : {};
  const subject = isRecord(value.subject) ? value.subject : {};
  const available = value.availableToPrincipal === true;
  const reason = stringValue(value.reason);
  return `${offeringReferenceSummary(reference)}  ${subjectSummary(subject)}  ${available ? "available" : `unavailable:${reason ?? "unknown"}`}`;
}

function formatSelection(value: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(value, null, 2);
  if (!isRecord(value)) return "Invalid Offering selection response";
  const reference = isRecord(value.reference) ? value.reference : {};
  const subject = isRecord(value.subject) ? value.subject : {};
  return `${offeringReferenceSummary(reference)}  ${subjectSummary(subject)}  resolver=${stringValue(value.resolverId) ?? "unknown"}  fingerprint=${stringValue(value.resolutionFingerprint) ?? "unknown"}`;
}

function offeringReferenceSummary(value: Record<string, unknown>): string {
  return `${stringValue(value.catalogId) ?? "unknown"}@${stringValue(value.catalogVersion) ?? "unknown"}/${stringValue(value.offeringId) ?? "unknown"}@${stringValue(value.offeringVersion) ?? "unknown"}`;
}

function subjectSummary(value: Record<string, unknown>): string {
  return `${stringValue(value.type) ?? "unknown-type"}:${stringValue(value.ref) ?? "unknown-ref"}@${stringValue(value.version) ?? "unknown-version"}`;
}
