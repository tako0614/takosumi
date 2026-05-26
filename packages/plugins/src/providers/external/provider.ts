import type { provider } from "takosumi-contract/reference/compat";
import type { RuntimeDesiredState } from "takosumi-contract/reference/compat";
import { freezeClone } from "./common.ts";

export type ExternalContainerEngine = "docker" | "podman";

export interface ExternalCommandRunner {
  run(input: ExternalCommandRunInput): Promise<ExternalCommandRunResult>;
}

export interface ExternalCommandRunInput {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

export interface ExternalCommandRunResult {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface ExternalContainerProviderOptions {
  readonly runner: ExternalCommandRunner;
  readonly engine?: ExternalContainerEngine;
  readonly projectPrefix?: string;
  readonly workingDirectory?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class ExternalContainerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #runner: ExternalCommandRunner;
  readonly #engine: ExternalContainerEngine;
  readonly #projectPrefix: string;
  readonly #workingDirectory?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #operations: provider.ProviderOperation[] = [];

  constructor(options: ExternalContainerProviderOptions) {
    this.#runner = options.runner;
    this.#engine = options.engine ?? "docker";
    this.#projectPrefix = options.projectPrefix ?? "takos";
    this.#workingDirectory = options.workingDirectory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const recordedAt = this.#now();
    const projectName = `${this.#projectPrefix}-${desiredState.activationId}`;
    const command = [
      this.#engine,
      "compose",
      "--project-name",
      projectName,
      "up",
      "--detach",
      "--remove-orphans",
    ];
    const result = await this.#runner.run({
      command,
      cwd: this.#workingDirectory,
      stdin: JSON.stringify({ desiredState }, null, 2),
    });
    const completedAt = result.completedAt ?? this.#now();
    const operation = freezeClone({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "external-container-compose",
      provider: "external",
      desiredStateId: desiredState.id,
      targetId: desiredState.activationId,
      targetName: desiredState.appName,
      command,
      details: {
        engine: this.#engine,
        projectName,
        workloadCount: desiredState.workloads.length,
        resourceCount: desiredState.resources.length,
        routeCount: desiredState.routes.length,
      },
      recordedAt,
      execution: {
        status: result.code === 0 ? "succeeded" as const : "failed" as const,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt: result.startedAt ?? recordedAt,
        completedAt,
      },
    });
    this.#operations.push(operation);
    return freezeClone({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "external",
      desiredStateId: desiredState.id,
      recordedAt,
      createdByOperationId: operation.id,
      operations: [operation],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve(
      this.#operations.map((operation) => freezeClone(operation)),
    );
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}
