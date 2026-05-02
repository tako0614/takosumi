import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import { freezeClone } from "./common.ts";

export type SelfHostedContainerEngine = "docker" | "podman";

export interface SelfHostedCommandRunner {
  run(input: SelfHostedCommandRunInput): Promise<SelfHostedCommandRunResult>;
}

export interface SelfHostedCommandRunInput {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

export interface SelfHostedCommandRunResult {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface SelfHostedContainerProviderOptions {
  readonly runner: SelfHostedCommandRunner;
  readonly engine?: SelfHostedContainerEngine;
  readonly projectPrefix?: string;
  readonly workingDirectory?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class SelfHostedContainerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #runner: SelfHostedCommandRunner;
  readonly #engine: SelfHostedContainerEngine;
  readonly #projectPrefix: string;
  readonly #workingDirectory?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #operations: provider.ProviderOperation[] = [];

  constructor(options: SelfHostedContainerProviderOptions) {
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
      kind: "selfhosted-container-compose",
      provider: "selfhosted",
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
      provider: "selfhosted",
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
