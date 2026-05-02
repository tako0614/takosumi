/**
 * VM / bare-metal provider materializer for the self-hosted profile.
 *
 * The container materializer (`SelfHostedContainerProviderMaterializer` in
 * `provider.ts`) serializes a desired state into `docker compose up`. This
 * materializer instead serializes it into a cloud-init document and pushes it
 * to an operator-injected `SelfHostedVmRunner`. The runner can wrap:
 *
 *   - SSH-based provisioning of an existing host
 *   - Cloud-vendor instance create (Hetzner, OCI, DO, EC2 raw, GCE raw)
 *   - Terraform-driven provisioning
 *   - Configuration management agents (Ansible, Salt) used as the apply path
 *
 * The materializer never talks to a cloud API itself; it is profile-neutral
 * VM glue that translates a Takos `RuntimeDesiredState` into the unit list a
 * VM-shaped target can apply.
 */
import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import { freezeClone } from "./common.ts";
import {
  type CloudInitSpec,
  type CloudInitSystemdUnit,
  type CloudInitWriteFile,
  renderCloudInit,
} from "./cloud_init.ts";

export type SelfHostedVmApplyMode = "cloud-init" | "ssh-runcmd";

export interface SelfHostedVmRunner {
  apply(input: SelfHostedVmApplyInput): Promise<SelfHostedVmApplyResult>;
  remove?(input: SelfHostedVmRemoveInput): Promise<SelfHostedVmRemoveResult>;
}

export interface SelfHostedVmApplyInput {
  readonly host: string;
  readonly mode: SelfHostedVmApplyMode;
  readonly cloudInit: string;
  readonly desiredStateId: string;
  readonly activationId: string;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedVmApplyResult {
  readonly status: "succeeded" | "failed";
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface SelfHostedVmRemoveInput {
  readonly host: string;
  readonly activationId: string;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedVmRemoveResult {
  readonly status: "succeeded" | "failed";
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface SelfHostedVmProviderOptions {
  readonly runner: SelfHostedVmRunner;
  /** SSH / DNS host the VM listens on. Pinned per profile, not per workload. */
  readonly host: string;
  /** Apply path. Defaults to `cloud-init`. */
  readonly mode?: SelfHostedVmApplyMode;
  /** Optional packages prepended to every workload provisioning. */
  readonly basePackages?: readonly string[];
  /** Optional reverse-proxy / router unit emitted alongside workloads. */
  readonly routerUnit?: CloudInitSystemdUnit;
  /** Optional shared write_files (env files, certs) injected once per apply. */
  readonly sharedFiles?: readonly CloudInitWriteFile[];
  /** Optional working directory. Forwarded to runner metadata. */
  readonly workingDirectory?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

/**
 * Implements `provider.ProviderMaterializer` by translating a runtime desired
 * state into a cloud-init document and asking the injected runner to apply it.
 */
export class SelfHostedVmProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #runner: SelfHostedVmRunner;
  readonly #host: string;
  readonly #mode: SelfHostedVmApplyMode;
  readonly #basePackages: readonly string[];
  readonly #routerUnit?: CloudInitSystemdUnit;
  readonly #sharedFiles: readonly CloudInitWriteFile[];
  readonly #workingDirectory?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #operations: provider.ProviderOperation[] = [];

  constructor(options: SelfHostedVmProviderOptions) {
    this.#runner = options.runner;
    this.#host = options.host;
    this.#mode = options.mode ?? "cloud-init";
    this.#basePackages = options.basePackages ?? [];
    this.#routerUnit = options.routerUnit;
    this.#sharedFiles = options.sharedFiles ?? [];
    this.#workingDirectory = options.workingDirectory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const recordedAt = this.#now();
    const cloudInit = renderCloudInit(this.#composeSpec(desiredState));
    const command = [
      "cloud-init",
      "apply",
      "--host",
      this.#host,
      "--mode",
      this.#mode,
    ];
    const result = await this.#runner.apply({
      host: this.#host,
      mode: this.#mode,
      cloudInit,
      desiredStateId: desiredState.id,
      activationId: desiredState.activationId,
      metadata: this.#workingDirectory
        ? { workingDirectory: this.#workingDirectory }
        : undefined,
    });
    const completedAt = result.completedAt ?? this.#now();
    const operation = freezeClone({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "selfhosted-vm-cloud-init" as const,
      provider: "selfhosted",
      desiredStateId: desiredState.id,
      targetId: desiredState.activationId,
      targetName: desiredState.appName,
      command,
      details: {
        host: this.#host,
        mode: this.#mode,
        workloadCount: desiredState.workloads.length,
        resourceCount: desiredState.resources.length,
        routeCount: desiredState.routes.length,
      },
      recordedAt,
      execution: {
        status: result.status,
        code: result.code ?? (result.status === "succeeded" ? 0 : 1),
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

  #composeSpec(desiredState: RuntimeDesiredState): CloudInitSpec {
    const units: CloudInitSystemdUnit[] = [];
    const writeFiles: CloudInitWriteFile[] = [...this.#sharedFiles];
    for (const workload of desiredState.workloads) {
      units.push(workloadUnit(workload, desiredState.activationId));
    }
    if (this.#routerUnit) units.push(this.#routerUnit);
    return {
      hostname: this.#host,
      packages: this.#basePackages.length > 0 ? this.#basePackages : undefined,
      writeFiles: writeFiles.length > 0 ? writeFiles : undefined,
      systemdUnits: units,
      finalMessage:
        `takos selfhosted-vm activation ${desiredState.activationId} ready`,
    };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function workloadUnit(
  workload: RuntimeDesiredState["workloads"][number],
  activationId: string,
): CloudInitSystemdUnit {
  const description =
    `Takos workload ${workload.id} (activation ${activationId})`;
  const execStart = workloadExecStart(workload);
  const contents = [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
  return {
    name: `takos-${workload.id}.service`,
    contents,
  };
}

function workloadExecStart(
  workload: RuntimeDesiredState["workloads"][number],
): string {
  const image = (workload as { image?: string }).image;
  if (image) {
    return `/usr/bin/podman run --rm --name takos-${workload.id} ${image}`;
  }
  const command = (workload as { command?: readonly string[] }).command;
  if (command && command.length > 0) {
    return command.map((arg) => quoteShell(arg)).join(" ");
  }
  return `/bin/false`;
}

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
