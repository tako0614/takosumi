import { Command } from "@cliffy/command";
import { loadConfig, resolveMode } from "../config.ts";
import { expandManifestLocal } from "../local_runner.ts";
import { loadManifest, resolveManifestPath } from "../manifest_loader.ts";

export interface DoctorOptions {
  readonly manifest?: string;
  readonly remote?: string;
  readonly token?: string;
  readonly cwd?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const lines = ["Takosumi doctor"];
  let ok = true;

  let manifestPath: string | undefined;
  try {
    manifestPath = await resolveManifestPath(options.manifest, {
      cwd: options.cwd,
    });
    const manifest = await loadManifest(manifestPath);
    lines.push(
      `[ok] manifest: ${
        displayPath(manifest.path, options.cwd)
      } (${manifest.format})`,
    );
    const resources = expandManifestLocal(manifest.value);
    lines.push(`[ok] resources: ${resources.length} resolved resource(s)`);
    const name = deploymentNameOf(manifest.value);
    if (name) lines.push(`[ok] deployment: ${name}`);
    else lines.push("[info] deployment: metadata.name not set");
  } catch (error) {
    ok = false;
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`[fail] manifest: ${message}`);
  }

  const config = await loadConfig();
  const target = resolveMode(
    { remote: options.remote, token: options.token },
    config,
  );
  if (target.mode === "remote") {
    lines.push(`[ok] mode: remote (${target.url})`);
    if (target.token) {
      lines.push("[ok] token: configured");
    } else {
      lines.push(
        "[warn] token: not configured; set --token or TAKOSUMI_DEPLOY_TOKEN if the kernel requires auth",
      );
    }
  } else {
    lines.push("[ok] mode: local (no remote configured)");
  }

  lines.push(
    manifestPath
      ? `[info] next: takosumi deploy ${displayPath(manifestPath, options.cwd)}`
      : "[info] next: takosumi init <output> (or use takosumi-git for project layout)",
  );

  return { ok, lines };
}

function createDoctorCommand() {
  return new Command()
    .description("Show the manifest, target, and auth Takosumi will use")
    .option("--manifest <path:string>", "Manifest path")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Auth token")
    .action(async ({ manifest, remote, token }) => {
      const report = await runDoctor({ manifest, remote, token });
      for (const line of report.lines) console.log(line);
      if (!report.ok) Deno.exit(1);
    });
}

function deploymentNameOf(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.metadata)) return undefined;
  return typeof value.metadata.name === "string" && value.metadata.name
    ? value.metadata.name
    : undefined;
}

function displayPath(path: string, cwd: string | undefined): string {
  const root = cwd ?? Deno.cwd();
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const doctorCommand: ReturnType<typeof createDoctorCommand> =
  createDoctorCommand();
