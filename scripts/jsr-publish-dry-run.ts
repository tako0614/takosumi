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

const KERNEL_DYNAMIC_IMPORT_WARNING =
  "kernel runtime plugin loading uses operator-provided module specifiers and verified data URLs; these imports are expected to resolve at runtime without JSR rewriting";

export const JSR_PUBLISH_PACKAGES: readonly JsrPublishPackage[] = Object.freeze(
  [
    {
      name: "@takos/takosumi-contract",
      version: "2.5.0",
      directory: "packages/contract",
    },
    {
      name: "@takos/takosumi-runtime-agent",
      version: "0.7.0",
      directory: "packages/runtime-agent",
    },
    {
      name: "@takos/takosumi-plugins",
      version: "0.12.0",
      directory: "packages/plugins",
    },
    {
      name: "@takos/takosumi-kernel",
      version: "0.14.0",
      directory: "packages/kernel",
      acceptedWarnings: Object.freeze([
        {
          code: "unanalyzable-dynamic-import",
          pathSuffix: "src/plugins/loader.ts",
          reason: KERNEL_DYNAMIC_IMPORT_WARNING,
        },
        {
          code: "unanalyzable-dynamic-import",
          pathSuffix: "src/plugins/marketplace.ts",
          reason: KERNEL_DYNAMIC_IMPORT_WARNING,
        },
      ]),
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
  const root = options.root ?? new URL("../", import.meta.url);
  let allOk = true;

  for (const packageInfo of JSR_PUBLISH_PACKAGES) {
    const ok = await runSinglePackageDryRun(root, packageInfo);
    allOk &&= ok;
  }

  return allOk;
}

async function runSinglePackageDryRun(
  root: URL,
  packageInfo: JsrPublishPackage,
): Promise<boolean> {
  const label = `${packageInfo.name}@${packageInfo.version}`;
  const cwd = new URL(`${packageInfo.directory}/`, root);
  console.log(`dry-run ${label}`);

  const command = new Deno.Command(Deno.execPath(), {
    args: ["publish", "--dry-run", "--quiet", "--allow-dirty"],
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
  const ok = await runJsrPublishDryRun();
  if (!ok) Deno.exit(1);
}
