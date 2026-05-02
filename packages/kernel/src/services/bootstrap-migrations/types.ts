import type { RuntimeConfig } from "../../config/runtime.ts";
import type { BootstrapReport } from "../bootstrap/mod.ts";
import type { ApplyStorageMigrationsResult } from "../../adapters/storage/migration-runner/mod.ts";

export type BootstrapMigrationStorageBackend = "plugin";

export interface BootstrapMigrationDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly key?: string;
}

export interface RunBootstrapMigrationsOptions {
  readonly dryRun?: boolean;
}

export interface BootstrapMigrationReport {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly storageBackend?: BootstrapMigrationStorageBackend;
  readonly skipped: boolean;
  readonly skipReason?: "plugin-owned";
  readonly diagnostics: readonly BootstrapMigrationDiagnostic[];
  readonly bootstrap: BootstrapReport;
  readonly runtimeConfig?: RuntimeConfig;
  readonly migrations?: ApplyStorageMigrationsResult;
}
