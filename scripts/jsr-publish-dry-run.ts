export interface JsrPublishPackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly acceptedWarnings?: readonly AcceptedPublishWarning[];
}

export interface AcceptedPublishWarning {
  readonly code: string;
  readonly pathSuffix: string;
  readonly reason: string;
}

export interface DenoPublishWarning {
  readonly code: string;
  readonly location?: string;
}

export interface DryRunDiagnostics {
  readonly ok: boolean;
  readonly warnings: readonly DenoPublishWarning[];
  readonly errors: readonly string[];
}

export type JsrTargetPublicationStatus =
  | "published"
  | "version-missing"
  | "package-missing"
  | "registry-error";

export interface JsrTargetPublicationCheck {
  readonly name: string;
  readonly targetVersion: string;
  readonly status: JsrTargetPublicationStatus;
  readonly message?: string;
  readonly createUrl?: string;
}

export const JSR_PUBLISH_PACKAGES: readonly JsrPublishPackage[] = Object.freeze(
  [
    {
      name: "@takos/takosumi-contract",
      version: "2.6.0",
      directory: "packages/contract",
    },
    {
      name: "@takos/takosumi-installer",
      version: "0.1.0",
      directory: "packages/installer",
    },
    {
      name: "@takos/takosumi-runtime-agent",
      version: "0.8.0",
      directory: "packages/runtime-agent",
    },
    {
      name: "@takos/takosumi-kind-gateway",
      version: "0.1.0",
      directory: "packages/kind-gateway",
    },
    {
      name: "@takos/takosumi-kind-kv-store",
      version: "0.1.0",
      directory: "packages/kind-kv-store",
    },
    {
      name: "@takos/takosumi-kind-message-queue",
      version: "0.1.0",
      directory: "packages/kind-message-queue",
    },
    {
      name: "@takos/takosumi-kind-object-store",
      version: "0.1.0",
      directory: "packages/kind-object-store",
    },
    {
      name: "@takos/takosumi-kind-postgres",
      version: "0.1.0",
      directory: "packages/kind-postgres",
    },
    {
      name: "@takos/takosumi-kind-sqlite",
      version: "0.1.0",
      directory: "packages/kind-sqlite",
    },
    {
      name: "@takos/takosumi-kind-vector-store",
      version: "0.1.0",
      directory: "packages/kind-vector-store",
    },
    {
      name: "@takos/takosumi-kind-web-service",
      version: "0.1.0",
      directory: "packages/kind-web-service",
    },
    {
      name: "@takos/takosumi-kind-worker",
      version: "0.1.0",
      directory: "packages/kind-worker",
    },
    {
      name: "@takos/takosumi-kernel",
      version: "0.14.0",
      directory: "packages/kernel",
    },
    {
      name: "@takos/takosumi-cli",
      version: "0.15.0",
      directory: "packages/cli",
    },
    {
      name: "@takos/takosumi",
      version: "0.17.0",
      directory: "packages/all",
    },
  ],
);

const decoder = new TextDecoder();

export function parseDenoPublishWarnings(
  output: string,
): readonly DenoPublishWarning[] {
  const warnings: DenoPublishWarning[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const codeMatch = lines[index].match(/^warning\[([^\]]+)\]/);
    if (!codeMatch) continue;

    let location: string | undefined;
    for (let probe = index + 1; probe < lines.length; probe++) {
      if (/^(warning|error)\[[^\]]+\]/.test(lines[probe])) break;
      const locationMatch = lines[probe].match(/-->\s+(.+?)(?::\d+:\d+)?$/);
      if (locationMatch) {
        location = locationMatch[1].trim();
        break;
      }
    }

    warnings.push({ code: codeMatch[1], location });
  }

  return Object.freeze(warnings);
}

export function parseDenoWarningCodes(output: string): readonly string[] {
  return Object.freeze(
    parseDenoPublishWarnings(output).map((item) => item.code),
  );
}

export function validateDryRunDiagnostics(
  packageInfo: JsrPublishPackage,
  output: string,
): DryRunDiagnostics {
  const warnings = parseDenoPublishWarnings(output);
  const errors = warnings
    .filter((warning) => !acceptedWarning(packageInfo, warning))
    .map((warning) => {
      const location = warning.location ? ` at ${warning.location}` : "";
      return `${packageInfo.name} emitted unexpected warning[${warning.code}]${location}`;
    });

  return {
    ok: errors.length === 0,
    warnings,
    errors: Object.freeze(errors),
  };
}

export async function runJsrPublishDryRun(options: {
  readonly root?: URL;
} = {}): Promise<boolean> {
  return await runJsrPublish({ ...options, dryRun: true });
}

export async function runJsrPublish(options: {
  readonly root?: URL;
  readonly dryRun: boolean;
  readonly fetch?: typeof fetch;
  readonly registryBaseUrl?: string;
  readonly apiBaseUrl?: string;
}): Promise<boolean> {
  const root = options.root ?? new URL("../", import.meta.url);
  let allOk = true;

  for (const packageInfo of JSR_PUBLISH_PACKAGES) {
    const ok = await runSinglePackagePublish({
      root,
      packageInfo,
      dryRun: options.dryRun,
      fetch: options.fetch ?? fetch,
      registryBaseUrl: options.registryBaseUrl ?? "https://jsr.io",
      apiBaseUrl: options.apiBaseUrl ?? "https://api.jsr.io",
    });
    allOk &&= ok;
  }

  return allOk;
}

async function runSinglePackagePublish(input: {
  readonly root: URL;
  readonly packageInfo: JsrPublishPackage;
  readonly dryRun: boolean;
  readonly fetch: typeof fetch;
  readonly registryBaseUrl: string;
  readonly apiBaseUrl: string;
}): Promise<boolean> {
  const { apiBaseUrl, dryRun, packageInfo, registryBaseUrl, root } = input;
  const label = `${packageInfo.name}@${packageInfo.version}`;
  const cwd = new URL(`${packageInfo.directory}/`, root);
  const action = dryRun ? "dry-run" : "publish";
  console.log(`${action} ${label}`);

  if (!dryRun) {
    const publication = await checkJsrTargetPublication(packageInfo, {
      fetch: input.fetch,
      apiBaseUrl,
      registryBaseUrl,
    });
    if (publication.status === "published") {
      console.log(`skip ${label} (already published)`);
      return true;
    }
    if (publication.status === "package-missing") {
      console.error(`failed ${label}`);
      console.error(
        `  ${publication.message ?? "JSR package record does not exist"}`,
      );
      if (publication.createUrl) {
        console.error(`  create package first: ${publication.createUrl}`);
      }
      return false;
    }
    if (publication.status === "registry-error") {
      console.error(`failed ${label}`);
      console.error(
        `  ${publication.message ?? "JSR registry status unknown"}`,
      );
      return false;
    }
  }

  const args = ["publish", "--quiet"];
  if (dryRun) args.push("--dry-run", "--allow-dirty");
  if (!dryRun) {
    const token = Deno.env.get("JSR_TOKEN")?.trim();
    if (!token) {
      console.error(`failed ${label}`);
      console.error("  JSR_TOKEN is required for publish mode");
      return false;
    }
    args.push("--token", token);
  }

  const command = new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  const diagnostics = `${stdout}\n${stderr}`;
  const validation = validateDryRunDiagnostics(packageInfo, diagnostics);

  if (!output.success || !validation.ok) {
    console.error(`failed ${label}`);
    for (const error of validation.errors) console.error(`  ${error}`);
    if (stdout.trim()) console.error(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
    return false;
  }

  if (validation.warnings.length === 0) {
    console.log(`ok ${label}`);
    return true;
  }

  console.log(`ok ${label} (${validation.warnings.length} accepted warnings)`);
  for (const warning of validation.warnings) {
    const accepted = packageInfo.acceptedWarnings?.find((candidate) =>
      warning.code === candidate.code &&
      warning.location?.endsWith(candidate.pathSuffix)
    );
    console.log(
      `  accepted warning[${warning.code}] ${
        warning.location ?? "(unknown location)"
      }: ${accepted?.reason ?? "accepted by package policy"}`,
    );
  }
  return true;
}

export async function checkJsrTargetPublication(
  packageInfo: JsrPublishPackage,
  options: {
    readonly fetch?: typeof fetch;
    readonly apiBaseUrl?: string;
    readonly registryBaseUrl?: string;
  } = {},
): Promise<JsrTargetPublicationCheck> {
  const fetchImpl = options.fetch ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.jsr.io";
  const registryBaseUrl = options.registryBaseUrl ?? "https://jsr.io";
  const url = `${
    registryBaseUrl.replace(/\/+$/, "")
  }/${packageInfo.name}/meta.json`;

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 404) {
    return await checkJsrPackageRecord(packageInfo, {
      apiBaseUrl,
      fetch: fetchImpl,
      registryBaseUrl,
    });
  }
  if (!response.ok) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "registry-error",
      message: `JSR registry returned HTTP ${response.status}`,
    };
  }

  let meta: { readonly versions?: unknown };
  try {
    meta = await response.json() as { readonly versions?: unknown };
  } catch (error) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const versions = meta.versions;
  const published = versions !== null && typeof versions === "object" &&
    !Array.isArray(versions) && packageInfo.version in versions;
  return {
    name: packageInfo.name,
    targetVersion: packageInfo.version,
    status: published ? "published" : "version-missing",
  };
}

async function checkJsrPackageRecord(
  packageInfo: JsrPublishPackage,
  options: {
    readonly apiBaseUrl: string;
    readonly fetch: typeof fetch;
    readonly registryBaseUrl: string;
  },
): Promise<JsrTargetPublicationCheck> {
  const packagePath = jsrPackageApiPath(packageInfo.name);
  if (!packagePath) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "package-missing",
      message: "JSR package record does not exist",
      createUrl: jsrCreatePackageUrl(packageInfo.name, options.registryBaseUrl),
    };
  }

  const url = `${options.apiBaseUrl.replace(/\/+$/, "")}${packagePath}`;
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { "accept": "application/json" },
    });
  } catch (error) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "registry-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 404) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "package-missing",
      message: "JSR package record does not exist",
      createUrl: jsrCreatePackageUrl(packageInfo.name, options.registryBaseUrl),
    };
  }
  if (!response.ok) {
    return {
      name: packageInfo.name,
      targetVersion: packageInfo.version,
      status: "registry-error",
      message: `JSR management API returned HTTP ${response.status}`,
    };
  }

  return {
    name: packageInfo.name,
    targetVersion: packageInfo.version,
    status: "version-missing",
  };
}

export function jsrCreatePackageUrl(
  packageName: string,
  registryBaseUrl = "https://jsr.io",
): string | undefined {
  const parsed = parseJsrPackageName(packageName);
  if (!parsed) return undefined;
  const base = registryBaseUrl.replace(/\/+$/, "");
  return `${base}/new?scope=${encodeURIComponent(parsed.scope)}&package=${
    encodeURIComponent(parsed.package)
  }&from=cli`;
}

function jsrPackageApiPath(packageName: string): string | undefined {
  const parsed = parseJsrPackageName(packageName);
  if (!parsed) return undefined;
  return `/scopes/${encodeURIComponent(parsed.scope)}/packages/${
    encodeURIComponent(parsed.package)
  }`;
}

function parseJsrPackageName(
  packageName: string,
): { readonly scope: string; readonly package: string } | undefined {
  const match = packageName.match(/^@([^/]+)\/(.+)$/);
  if (!match) return undefined;
  return { scope: match[1], package: match[2] };
}

function acceptedWarning(
  packageInfo: JsrPublishPackage,
  warning: DenoPublishWarning,
): boolean {
  return packageInfo.acceptedWarnings?.some((accepted) =>
    warning.code === accepted.code &&
    warning.location?.endsWith(accepted.pathSuffix)
  ) ?? false;
}

if (import.meta.main) {
  const mode = parseMode(Deno.args);
  if (!mode) {
    console.error(
      "Usage: deno run --allow-run --allow-read scripts/jsr-publish-dry-run.ts [--dry-run|--publish]",
    );
    Deno.exit(2);
  }
  const ok = await runJsrPublish({ dryRun: mode === "dry-run" });
  if (!ok) Deno.exit(1);
}

export function parseMode(
  args: readonly string[],
): "dry-run" | "publish" | null {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  if (args.length === 1 && args[0] === "--publish") return "publish";
  return null;
}
