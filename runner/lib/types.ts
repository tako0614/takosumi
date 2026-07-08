// runner/lib/types.ts
//
// Shared type and interface declarations for the OpenTofu runner.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.

export type OpenTofuRunAction =
  | "plan"
  | "apply"
  | "destroy"
  | "compatibility_check"
  | "backup"
  | "release";
export type OpenTofuOperation = "create" | "update" | "destroy";
export type JsonRecord = Record<string, unknown>;
export type RunRequest = {
  readonly action?: unknown;
  readonly runId?: unknown;
  readonly request?: unknown;
};

export type OpenTofuModuleSource =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
      readonly commit?: string;
      readonly modulePath?: string;
    }
  | {
      readonly kind: "prepared";
      readonly url: string;
      readonly digest: string;
      readonly modulePath?: string;
    }
  | {
      readonly kind: "local";
      readonly path: string;
      readonly modulePath?: string;
    };

export interface RunWorkspace {
  readonly root: string;
  readonly sourceRoot: string;
  readonly moduleDir: string;
  readonly planPath: string;
  readonly restoredStatePath: string;
  readonly moduleInfoPath: string;
  // Generated-root workspace dirs. `generatedRootDir` is where tofu runs (it
  // holds the generated root module + child `template-module`); `artifactDir`
  // receives runner-produced backup/provider-snapshot metadata artifacts.
  readonly generatedRootDir: string;
  readonly templateModuleDir: string;
  readonly artifactDir: string;
  // remote_state dependency states (spec §15): each producer state is written
  // read-only as <depsDir>/<name>.tfstate before init/plan/apply for the
  // consumer's `terraform_remote_state` data sources.
  readonly depsDir: string;
}

/** Generated root module HCL files (filename -> content). */
export interface GeneratedRoot {
  readonly files: Record<string, string>;
  readonly moduleFiles?: readonly GeneratedRootModuleFile[];
}

export interface GeneratedRootModuleFile {
  readonly path: string;
  readonly text: string;
}

export interface BackupSpec {
  readonly mode: "provider_snapshot" | "custom_command";
  readonly command?: readonly string[];
  readonly outputPath: string;
  readonly provider?: string;
}

export interface ReleaseCommandSpec {
  readonly id: string;
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
}

export interface ReleaseSpec {
  readonly commands: readonly ReleaseCommandSpec[];
  readonly outputs?: JsonRecord;
  readonly activation?: ReleaseActivationSpec;
}

export interface ReleaseActivationSpec {
  readonly applyRunId?: string;
  readonly workspaceId?: string;
  readonly spaceId?: string;
  readonly installationId?: string;
  readonly deploymentId?: string;
}

export interface CommandContext {
  readonly env: Record<string, string>;
  readonly credentialFiles?: readonly ProviderCredentialFile[];
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
  readonly sourceArchiveMaxBytes?: number;
  readonly sourceArchiveMaxDecompressedBytes?: number;
}

export interface ProviderCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
  readonly envName?: string;
}
export interface PlanResponseOptions {
  readonly operation: OpenTofuOperation;
  readonly commandContext: CommandContext;
  readonly requiredProviders: readonly string[];
  readonly providerInstallationPolicy?: {
    readonly requireMirror: boolean;
  };
  readonly buildLog?: string;
  readonly extra?: JsonRecord;
}
export interface SourceSyncSource {
  readonly url: string;
  readonly ref: string;
  readonly path: string;
}

export interface SourceCredentialFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

export interface SourceCredentials {
  readonly env: Record<string, string>;
  readonly files: readonly SourceCredentialFile[];
}

export interface SourceGitContext {
  readonly context: CommandContext;
}

export interface TarVerboseEntry {
  readonly type: string;
  readonly path: string;
  readonly size: number;
}

export interface PreparedProviderCredentialFiles {
  readonly context: CommandContext;
  readonly cleanup: () => Promise<void>;
}

export interface RunnerPolicyBeforeInitOptions {
  readonly allowProviderFreeGeneratedRoot?: boolean;
  readonly requiredProviders?: readonly string[];
}

export interface StrictProviderMirrorAttestation {
  readonly providers: readonly string[];
  readonly cliConfigPath: string;
  readonly cliConfigDigest: string;
}

export interface ProviderMirrorInit {
  readonly commandContext: CommandContext;
  readonly providerCacheDir: string;
  readonly sharedProviderCache: boolean;
  readonly attestation?: StrictProviderMirrorAttestation;
}
