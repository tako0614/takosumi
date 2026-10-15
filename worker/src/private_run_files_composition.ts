import { PRIVATE_RUN_FILE_HTTP_PATH, PRIVATE_RUN_FILE_MAX_BYTES } from "../../core/api/private_run_file_routes.ts";
import type { WorkerPrivateRunFilesComposition } from "./worker_service.ts";

type Environment = Readonly<{
  TAKOSUMI_PRIVATE_RUN_FILES?: string;
  TAKOSUMI_PRIVATE_RUN_FILES_COMPOSITION?: WorkerPrivateRunFilesComposition;
}>;
type Snapshot = Readonly<{
  raw: unknown;
  supplied: unknown;
  configuration: WorkerPrivateRunFilesComposition | undefined;
}>;
const snapshots = new WeakMap<object, Snapshot>();
const configurations = new WeakSet<object>();
const keys = ["endpoint", "maxBytes", "prefix"];

/** Nonsecret host configuration only; no slots, grants or readiness assertion. */
export function privateRunFilesCompositionFor(env: Environment): WorkerPrivateRunFilesComposition | undefined {
  const raw = env.TAKOSUMI_PRIVATE_RUN_FILES;
  const supplied = env.TAKOSUMI_PRIVATE_RUN_FILES_COMPOSITION;
  const existing = snapshots.get(env);
  if (existing) {
    if (existing.raw !== raw || existing.supplied !== supplied) throw new TypeError("private Run files composition cannot change");
    return existing.configuration;
  }
  let configuration: WorkerPrivateRunFilesComposition | undefined;
  if (raw !== undefined) {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 4096) invalid();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { invalid(); }
    configuration = validate(value);
  }
  if (supplied !== undefined) {
    const checked = validate(supplied);
    if (!configuration || !configurations.has(supplied) || keys.some(key => checked[key as keyof WorkerPrivateRunFilesComposition] !== configuration![key as keyof WorkerPrivateRunFilesComposition])) invalid();
    configuration = supplied;
  }
  snapshots.set(env, Object.freeze({ raw, supplied, configuration }));
  return configuration;
}

function validate(value: unknown): WorkerPrivateRunFilesComposition {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) invalid();
  const record = value as Record<string, unknown>;
  if (typeof record.endpoint !== "string" || typeof record.prefix !== "string" || record.maxBytes !== PRIVATE_RUN_FILE_MAX_BYTES) invalid();
  let endpoint: URL;
  try { endpoint = new URL(record.endpoint); } catch { invalid(); }
  if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.pathname !== PRIVATE_RUN_FILE_HTTP_PATH || `${endpoint.origin}${endpoint.pathname}` !== record.endpoint) invalid();
  // Match the existing R2 adapter's canonical prefix and stricter 240-byte bound.
  const prefix = record.prefix;
  if (!prefix || prefix.length > 240 || prefix.split("/").some(part => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")) invalid();
  const configuration = Object.freeze({ endpoint: record.endpoint, prefix, maxBytes: PRIVATE_RUN_FILE_MAX_BYTES });
  configurations.add(configuration);
  return configuration;
}

function invalid(): never { throw new TypeError("private Run files composition is invalid"); }
