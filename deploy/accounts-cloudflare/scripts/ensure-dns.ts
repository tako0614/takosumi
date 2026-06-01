interface Options {
  readonly zoneName: string;
  readonly zoneId: string | null;
  readonly recordName: string;
  readonly target: string;
  readonly token: string | null;
  readonly apiBaseUrl: string;
  readonly check: boolean;
  readonly apply: boolean;
  readonly failOnNotReady: boolean;
}

const defaultCloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4";

interface DnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly proxied?: boolean;
  readonly ttl?: number;
}

function parseArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  let zoneName = env.TAKOSUMI_ACCOUNTS_CLOUDFLARE_ZONE_NAME ?? "takosumi.com";
  let zoneId = env.CLOUDFLARE_ZONE_ID ?? null;
  let recordName = env.TAKOSUMI_ACCOUNTS_DNS_RECORD_NAME ??
    "accounts.takosumi.com";
  let target = workersDevHostnameFromEnv(env);
  const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN ?? null;
  let apiBaseUrl = env.TAKOSUMI_CLOUDFLARE_API_BASE_URL ??
    defaultCloudflareApiBaseUrl;
  let check = false;
  let apply = false;
  let failOnNotReady = env.TAKOSUMI_CLOUDFLARE_DNS_FAIL_ON_NOT_READY === "1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--zone-name") {
      zoneName = requiredValue(args, ++index, arg);
    } else if (arg === "--zone-id") {
      zoneId = requiredValue(args, ++index, arg);
    } else if (arg === "--record-name") {
      recordName = requiredValue(args, ++index, arg);
    } else if (arg === "--target") {
      target = requiredValue(args, ++index, arg);
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--apply") {
      apply = true;
      check = true;
    } else if (arg === "--fail-on-not-ready") {
      failOnNotReady = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new TypeError(`Unknown option: ${arg}`);
    }
  }

  if (!validHostname(zoneName)) {
    throw new TypeError("--zone-name must be a hostname");
  }
  if (!validHostname(recordName)) {
    throw new TypeError("--record-name must be a hostname");
  }
  if (!recordName.endsWith(`.${zoneName}`) && recordName !== zoneName) {
    throw new TypeError("--record-name must be inside --zone-name");
  }
  if (!target) {
    throw new TypeError(
      "--target or TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME is required",
    );
  }
  if (!validHostname(target)) {
    throw new TypeError(
      "--target or TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME must be a hostname",
    );
  }
  apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);

  return {
    zoneName,
    zoneId,
    recordName,
    target,
    token,
    apiBaseUrl,
    check,
    apply,
    failOnNotReady,
  };
}

function workersDevHostnameFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const explicit = env.TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME?.trim();
  if (explicit) return explicit;
  const urlValue = env.TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL?.trim();
  if (!urlValue) return null;
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new TypeError("TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL must be HTTP(S)");
  }
  return url.hostname;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function validHostname(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i
    .test(value);
}

function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("TAKOSUMI_CLOUDFLARE_API_BASE_URL must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("TAKOSUMI_CLOUDFLARE_API_BASE_URL must be HTTP(S)");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function cloudflareRequest(
  token: string,
  apiBaseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<
  { readonly status: number; readonly body: Record<string, unknown> }
> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: typeof body === "object" && body !== null
      ? body as Record<string, unknown>
      : {},
  };
}

function resultArray(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.result)
    ? body.result.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null
    )
    : [];
}

function errorCodes(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.errors)
    ? body.errors.map((item) =>
      typeof item === "object" && item !== null && "code" in item
        ? item.code
        : item
    )
    : [];
}

function permissionHint(
  phase: "zoneLookup" | "recordLookup" | "recordApply",
  status: number | undefined,
  codes: unknown[],
): Record<string, unknown> | undefined {
  const hasPermissionFailure = status === 401 || status === 403 ||
    codes.some((code) => String(code) === "10000");
  if (!hasPermissionFailure) return undefined;
  const writePhase = phase === "recordApply";
  return {
    phase,
    reason: "cloudflare-dns-permission-required",
    requiredPermission: writePhase
      ? "Cloudflare Zone:DNS Edit permission for the managed zone"
      : "Cloudflare Zone:DNS Read permission for the managed zone",
    credential: "CLOUDFLARE_API_TOKEN or CF_API_TOKEN",
  };
}

function recordFromResult(value: Record<string, unknown>): DnsRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.name !== "string" ||
    typeof value.content !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    type: value.type,
    name: value.name,
    content: value.content,
    proxied: typeof value.proxied === "boolean" ? value.proxied : undefined,
    ttl: typeof value.ttl === "number" ? value.ttl : undefined,
  };
}

function publicDnsRecord(
  record: DnsRecord | null,
): Record<string, unknown> | null {
  if (!record) return null;
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  };
}

function plannedRecord(options: Options): Record<string, unknown> {
  return {
    type: "CNAME",
    name: options.recordName,
    content: options.target,
    proxied: true,
    ttl: 1,
  };
}

async function resolveZoneId(
  options: Options,
): Promise<
  | {
    readonly ok: true;
    readonly zoneId: string;
    readonly zoneLookup?: unknown;
  }
  | { readonly ok: false; readonly zoneLookup: unknown }
> {
  if (options.zoneId) return { ok: true, zoneId: options.zoneId };
  if (!options.token) {
    return {
      ok: false,
      zoneLookup: {
        ok: false,
        reason: "missing Cloudflare API token",
      },
    };
  }
  const lookup = await cloudflareRequest(
    options.token,
    options.apiBaseUrl,
    `/zones?name=${encodeURIComponent(options.zoneName)}&status=active`,
  );
  const zones = resultArray(lookup.body);
  const zoneId = typeof zones[0]?.id === "string" ? zones[0].id : null;
  if (lookup.body.success === true && zoneId) {
    return {
      ok: true,
      zoneId,
      zoneLookup: {
        status: lookup.status,
        success: true,
        zoneCount: zones.length,
      },
    };
  }
  return {
    ok: false,
    zoneLookup: {
      status: lookup.status,
      success: lookup.body.success === true,
      zoneCount: zones.length,
      errorCodes: errorCodes(lookup.body),
      permissionHint: permissionHint(
        "zoneLookup",
        lookup.status,
        errorCodes(lookup.body),
      ),
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = plannedRecord(options);
  const baseReport: Record<string, unknown> = {
    kind: "takosumi.cloudflare-dns-record-plan@v1",
    checkedAt: new Date().toISOString(),
    ok: !options.check,
    mode: options.apply ? "apply" : options.check ? "check" : "plan",
    zoneName: options.zoneName,
    recordName: options.recordName,
    plannedRecord: plan,
    cloudflareApiBaseUrl: options.apiBaseUrl,
    cloudflareApiBaseUrlDefault:
      options.apiBaseUrl === defaultCloudflareApiBaseUrl,
  };

  if (!options.check) {
    console.log(JSON.stringify(
      {
        ...baseReport,
        next:
          "Run with --check to inspect Cloudflare, or --apply with a token that has zone DNS permission.",
      },
      null,
      2,
    ));
    return;
  }

  if (!options.token) {
    console.log(JSON.stringify(
      {
        ...baseReport,
        ok: false,
        reason: "Cloudflare API token is required for --check/--apply",
      },
      null,
      2,
    ));
    process.exit(1);
  }

  const zone = await resolveZoneId(options);
  if (!zone.ok) {
    console.log(JSON.stringify(
      {
        ...baseReport,
        ok: false,
        zoneLookup: zone.zoneLookup,
      },
      null,
      2,
    ));
    process.exit(1);
  }

  const recordLookup = await cloudflareRequest(
    options.token,
    options.apiBaseUrl,
    `/zones/${zone.zoneId}/dns_records?name=${
      encodeURIComponent(options.recordName)
    }`,
  );
  const recordLookupReport = {
    status: recordLookup.status,
    success: recordLookup.body.success === true,
    recordCount: resultArray(recordLookup.body).length,
    errorCodes: errorCodes(recordLookup.body),
    permissionHint: permissionHint(
      "recordLookup",
      recordLookup.status,
      errorCodes(recordLookup.body),
    ),
  };
  if (recordLookup.body.success !== true) {
    const report = {
      ...baseReport,
      ok: false,
      zoneResolved: true,
      recordLookup: recordLookupReport,
      existingRecord: null,
      action: "lookup-failed",
      applySkipped: options.apply
        ? "DNS record lookup failed; provide a token with Zone:DNS Read and Zone:DNS Edit permission before --apply."
        : undefined,
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.apply || options.failOnNotReady) process.exit(1);
    return;
  }
  const existing = resultArray(recordLookup.body)
    .map(recordFromResult)
    .find((record): record is DnsRecord => record !== null) ?? null;
  const existingMatches = existing?.type === "CNAME" &&
    existing.content === options.target &&
    existing.proxied === true;
  const action = existingMatches ? "none" : existing ? "update" : "create";

  if (!options.apply || action === "none") {
    const report = {
      ...baseReport,
      ok: recordLookup.body.success === true && action === "none",
      zoneResolved: true,
      recordLookup: recordLookupReport,
      existingRecord: publicDnsRecord(existing),
      action,
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.failOnNotReady && !report.ok) process.exit(1);
    return;
  }

  const method = existing ? "PUT" : "POST";
  const path = existing
    ? `/zones/${zone.zoneId}/dns_records/${existing.id}`
    : `/zones/${zone.zoneId}/dns_records`;
  const upsert = await cloudflareRequest(
    options.token,
    options.apiBaseUrl,
    path,
    {
      method,
      body: JSON.stringify(plan),
    },
  );

  console.log(JSON.stringify(
    {
      ...baseReport,
      ok: upsert.body.success === true,
      zoneResolved: true,
      existingRecord: publicDnsRecord(existing),
      action,
      upsert: {
        status: upsert.status,
        success: upsert.body.success === true,
        errorCodes: errorCodes(upsert.body),
        permissionHint: permissionHint(
          "recordApply",
          upsert.status,
          errorCodes(upsert.body),
        ),
      },
    },
    null,
    2,
  ));
  if (upsert.body.success !== true) process.exit(1);
}

function printHelp(): void {
  console.log(
    `Usage: bun run deploy:accounts-cloudflare:ensure-dns -- [options]

Default mode prints the intended proxied CNAME without contacting Cloudflare.

Options:
  --zone-name <name>     Zone name. Defaults to takosumi.com.
  --zone-id <id>         Zone ID. Avoids zone lookup when provided.
  --record-name <name>   DNS record name. Defaults to accounts.takosumi.com.
  --target <hostname>    CNAME target. Required unless TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME
                         or TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL is set.
  --check                Read Cloudflare DNS state.
  --apply                Create/update the proxied CNAME.
  --fail-on-not-ready    Exit non-zero when --check finds a missing or drifted record.
`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
import process from "node:process";
