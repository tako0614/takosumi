import {
  JSR_PUBLISH_PACKAGES,
  type JsrPublishPackage,
} from "./jsr-publish-dry-run.ts";

export type JsrPackageReadinessStatus =
  | "published"
  | "version-missing"
  | "package-missing"
  | "registry-error";

export interface JsrPackageReadiness {
  readonly name: string;
  readonly targetVersion: string;
  readonly status: JsrPackageReadinessStatus;
  readonly latest?: string;
  readonly publishedVersions?: readonly string[];
  readonly message?: string;
}

interface JsrMeta {
  readonly latest?: unknown;
  readonly versions?: unknown;
}

export async function checkJsrPackageReadiness(options: {
  readonly packages?: readonly JsrPublishPackage[];
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly registryBaseUrl?: string;
} = {}): Promise<readonly JsrPackageReadiness[]> {
  const packages = options.packages ?? JSR_PUBLISH_PACKAGES;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.jsr.io";
  const fetchImpl = options.fetch ?? fetch;
  const registryBaseUrl = options.registryBaseUrl ?? "https://jsr.io";
  const results: JsrPackageReadiness[] = [];

  for (const packageInfo of packages) {
    results.push(
      await checkSinglePackage({
        apiBaseUrl,
        packageInfo,
        fetch: fetchImpl,
        registryBaseUrl,
      }),
    );
  }

  return Object.freeze(results);
}

async function checkSinglePackage(input: {
  readonly apiBaseUrl: string;
  readonly packageInfo: JsrPublishPackage;
  readonly fetch: typeof fetch;
  readonly registryBaseUrl: string;
}): Promise<JsrPackageReadiness> {
  const url = `${
    input.registryBaseUrl.replace(/\/+$/, "")
  }/${input.packageInfo.name}/meta.json`;
  let response: Response;
  try {
    response = await input.fetch(url);
  } catch (error) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 404) {
    return await checkEmptyOrMissingPackageRecord(input);
  }
  if (!response.ok) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "registry-error",
      message: `JSR registry returned HTTP ${response.status}`,
    };
  }

  let meta: JsrMeta;
  try {
    meta = await response.json() as JsrMeta;
  } catch (error) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const versions = versionsFromMeta(meta.versions);
  const latest = typeof meta.latest === "string" ? meta.latest : undefined;
  if (versions.includes(input.packageInfo.version)) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "published",
      latest,
      publishedVersions: versions,
    };
  }

  return {
    name: input.packageInfo.name,
    targetVersion: input.packageInfo.version,
    status: "version-missing",
    latest,
    publishedVersions: versions,
    message: "JSR package exists, but target version is not published",
  };
}

async function checkEmptyOrMissingPackageRecord(input: {
  readonly apiBaseUrl: string;
  readonly packageInfo: JsrPublishPackage;
  readonly fetch: typeof fetch;
}): Promise<JsrPackageReadiness> {
  const packagePath = jsrPackageApiPath(input.packageInfo.name);
  if (!packagePath) {
    return missingPackage(input.packageInfo);
  }

  const url = `${input.apiBaseUrl.replace(/\/+$/, "")}${packagePath}`;
  let response: Response;
  try {
    response = await input.fetch(url, {
      headers: { "accept": "application/json" },
    });
  } catch (error) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 404) return missingPackage(input.packageInfo);
  if (!response.ok) {
    return {
      name: input.packageInfo.name,
      targetVersion: input.packageInfo.version,
      status: "registry-error",
      message: `JSR management API returned HTTP ${response.status}`,
    };
  }

  return {
    name: input.packageInfo.name,
    targetVersion: input.packageInfo.version,
    status: "version-missing",
    publishedVersions: [],
    message: "JSR package exists, but target version is not published",
  };
}

function missingPackage(packageInfo: JsrPublishPackage): JsrPackageReadiness {
  return {
    name: packageInfo.name,
    targetVersion: packageInfo.version,
    status: "package-missing",
    message: "JSR package record does not exist",
  };
}

function versionsFromMeta(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.freeze(Object.keys(value).sort(compareSemverish));
}

function compareSemverish(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (Number.isFinite(delta) && delta !== 0) return delta;
  }
  return left.localeCompare(right);
}

function jsrPackageApiPath(packageName: string): string | undefined {
  const match = packageName.match(/^@([^/]+)\/(.+)$/);
  if (!match) return undefined;
  return `/scopes/${encodeURIComponent(match[1])}/packages/${
    encodeURIComponent(match[2])
  }`;
}

export function summarizeJsrReadiness(
  results: readonly JsrPackageReadiness[],
): string {
  const lines = results.map((result) => {
    const suffix = result.status === "published"
      ? `latest=${result.latest ?? "(unknown)"}`
      : result.message ?? "";
    return `${
      result.status.padEnd(15)
    } ${result.name}@${result.targetVersion} ${suffix}`.trimEnd();
  });
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const results = await checkJsrPackageReadiness();
  Deno.stdout.write(new TextEncoder().encode(summarizeJsrReadiness(results)));
  if (results.some((result) => result.status !== "published")) {
    Deno.exit(1);
  }
}
