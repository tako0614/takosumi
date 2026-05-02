import type { OperatorConfigPort } from "../../adapters/operator-config/mod.ts";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
  RuntimeConfigError,
} from "../../config/runtime.ts";
import { StandaloneBootstrapService } from "../bootstrap/mod.ts";
import type {
  BootstrapMigrationDiagnostic,
  BootstrapMigrationReport,
  RunBootstrapMigrationsOptions,
} from "./types.ts";

export interface BootstrapMigrationServiceOptions {
  readonly operatorConfig: OperatorConfigPort;
  readonly clock?: () => Date;
}

export class BootstrapMigrationService {
  readonly #operatorConfig: OperatorConfigPort;
  readonly #clock: () => Date;

  constructor(options: BootstrapMigrationServiceOptions) {
    this.#operatorConfig = options.operatorConfig;
    this.#clock = options.clock ?? (() => new Date());
  }

  async run(
    options: RunBootstrapMigrationsOptions = {},
  ): Promise<BootstrapMigrationReport> {
    const generatedAt = this.#clock().toISOString();
    const dryRun = options.dryRun === true;
    const diagnostics: BootstrapMigrationDiagnostic[] = [];
    const bootstrap = await new StandaloneBootstrapService({
      operatorConfig: this.#operatorConfig,
      clock: this.#clock,
    }).bootstrap();

    diagnostics.push(...bootstrap.warnings, ...bootstrap.errors);

    const runtimeConfig = await this.#loadRuntimeConfig(diagnostics);
    if (!runtimeConfig) {
      return freezeReport({
        ok: false,
        generatedAt,
        dryRun,
        skipped: false,
        diagnostics,
        bootstrap,
      });
    }

    return freezeReport({
      ok: hasNoErrors(diagnostics),
      generatedAt,
      dryRun,
      storageBackend: "plugin",
      skipped: true,
      skipReason: "plugin-owned",
      diagnostics,
      bootstrap,
      runtimeConfig,
    });
  }

  async #loadRuntimeConfig(
    diagnostics: BootstrapMigrationDiagnostic[],
  ): Promise<RuntimeConfig | undefined> {
    try {
      return await loadRuntimeConfig({ operatorConfig: this.#operatorConfig });
    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        diagnostics.push(...error.diagnostics);
        return undefined;
      }
      throw error;
    }
  }
}

function hasNoErrors(
  diagnostics: readonly BootstrapMigrationDiagnostic[],
): boolean {
  return diagnostics.every((diagnostic) => diagnostic.severity !== "error");
}

function freezeReport<T extends BootstrapMigrationReport>(report: T): T {
  return deepFreeze(report);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
