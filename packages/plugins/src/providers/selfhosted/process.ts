/**
 * Subprocess lifecycle helper for the self-hosted profile.
 *
 * Runtime-agent connects to this when the operator runs Takos workloads as
 * systemd-style units (or simple `docker run` / `podman run` invocations).
 * The helper standardises:
 *
 *   - `ensure(spec)` — start the process if not already running, idempotently
 *   - `status(name)` — fetch a structured `SelfHostedProcessStatus`
 *   - `stop(name)`   — graceful stop (SIGTERM → SIGKILL after `gracePeriodMs`)
 *   - `restart(spec)`/`logs(name)` — convenience wrappers
 *
 * Operators inject a `SelfHostedProcessRunner` that knows how to actually
 * launch processes. The runner contract is intentionally narrow so it can wrap
 * `Deno.Command`, `child_process.spawn`, `systemctl`, or a Compose-style
 * controller without leaking implementation details.
 */
import { freezeClone } from "./common.ts";

export type SelfHostedProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";

export interface SelfHostedProcessSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly env?: Record<string, string>;
  readonly workingDirectory?: string;
  readonly restart?: "always" | "on-failure" | "never";
  readonly user?: string;
  readonly gracePeriodMs?: number;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedProcessStatus {
  readonly name: string;
  readonly state: SelfHostedProcessState;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly exitCode?: number;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedProcessRunner {
  start(spec: SelfHostedProcessSpec): Promise<SelfHostedProcessStatus>;
  status(name: string): Promise<SelfHostedProcessStatus | undefined>;
  stop(input: {
    readonly name: string;
    readonly gracePeriodMs?: number;
    readonly force?: boolean;
  }): Promise<SelfHostedProcessStatus>;
  list?(): Promise<readonly SelfHostedProcessStatus[]>;
  logs?(input: {
    readonly name: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly entries: readonly SelfHostedProcessLogEntry[];
    readonly nextCursor?: string;
  }>;
}

export interface SelfHostedProcessLogEntry {
  readonly stream: "stdout" | "stderr";
  readonly timestamp: string;
  readonly message: string;
}

export type SelfHostedProcessConditionType =
  | "ProcessReady"
  | "ProcessStopped"
  | "ProcessRestarted"
  | "ProcessFailed";

export interface SelfHostedProcessCondition {
  readonly type: SelfHostedProcessConditionType;
  readonly status: "true" | "false" | "unknown";
  readonly reason?: string;
  readonly message?: string;
  readonly observedAt: string;
}

export type SelfHostedProcessConditionSink = (
  condition: SelfHostedProcessCondition,
) => void;

export interface SelfHostedProcessControllerOptions {
  readonly runner: SelfHostedProcessRunner;
  readonly clock?: () => Date;
  readonly defaultGracePeriodMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly conditionSink?: SelfHostedProcessConditionSink;
}

export class SelfHostedProcessController {
  readonly #runner: SelfHostedProcessRunner;
  readonly #clock: () => Date;
  readonly #defaultGrace: number;
  readonly #readinessTimeout: number;
  readonly #readinessInterval: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #sink?: SelfHostedProcessConditionSink;

  constructor(options: SelfHostedProcessControllerOptions) {
    this.#runner = options.runner;
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultGrace = options.defaultGracePeriodMs ?? 10_000;
    this.#readinessTimeout = options.readinessTimeoutMs ?? 30_000;
    this.#readinessInterval = options.readinessIntervalMs ?? 200;
    this.#sleep = options.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.#sink = options.conditionSink;
  }

  /**
   * Starts the process if not already running. Polls `runner.status` until the
   * process reaches `running` or the readiness budget is exhausted.
   */
  async ensure(spec: SelfHostedProcessSpec): Promise<SelfHostedProcessStatus> {
    const existing = await this.#runner.status(spec.name);
    if (existing?.state === "running") {
      this.#emit("ProcessReady", "true", "AlreadyRunning");
      return freezeClone(existing);
    }
    const startStatus = await this.#runner.start(spec);
    if (startStatus.state === "running") {
      this.#emit("ProcessReady", "true", "Started");
      return freezeClone(startStatus);
    }
    return await this.#waitForRunning(spec.name, startStatus);
  }

  async status(name: string): Promise<SelfHostedProcessStatus | undefined> {
    const status = await this.#runner.status(name);
    return status ? freezeClone(status) : undefined;
  }

  async stop(
    name: string,
    options: { readonly force?: boolean; readonly gracePeriodMs?: number } = {},
  ): Promise<SelfHostedProcessStatus> {
    const status = await this.#runner.stop({
      name,
      gracePeriodMs: options.gracePeriodMs ?? this.#defaultGrace,
      force: options.force,
    });
    this.#emit("ProcessStopped", "true", options.force ? "Forced" : "Graceful");
    return freezeClone(status);
  }

  async restart(spec: SelfHostedProcessSpec): Promise<SelfHostedProcessStatus> {
    const status = await this.#runner.status(spec.name);
    if (status?.state === "running" || status?.state === "starting") {
      await this.stop(spec.name, { gracePeriodMs: spec.gracePeriodMs });
    }
    const result = await this.ensure(spec);
    this.#emit("ProcessRestarted", "true", "Restarted");
    return result;
  }

  async list(): Promise<readonly SelfHostedProcessStatus[]> {
    if (!this.#runner.list) return [];
    const items = await this.#runner.list();
    return items.map((item) => freezeClone(item));
  }

  async logs(
    name: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<{
    readonly entries: readonly SelfHostedProcessLogEntry[];
    readonly nextCursor?: string;
  }> {
    if (!this.#runner.logs) return { entries: [] };
    const result = await this.#runner.logs({ name, ...options });
    return freezeClone(result);
  }

  async #waitForRunning(
    name: string,
    initial: SelfHostedProcessStatus,
  ): Promise<SelfHostedProcessStatus> {
    const start = this.#clock().getTime();
    let last = initial;
    while (this.#clock().getTime() - start < this.#readinessTimeout) {
      const current = await this.#runner.status(name);
      if (current) last = current;
      if (current?.state === "running") {
        this.#emit("ProcessReady", "true", "Started");
        return freezeClone(current);
      }
      if (current?.state === "failed") {
        const failure = freezeClone(current);
        this.#emit(
          "ProcessFailed",
          "true",
          "FailedDuringStart",
          `exit code ${current.exitCode ?? "unknown"}`,
        );
        return failure;
      }
      await this.#sleep(this.#readinessInterval);
    }
    this.#emit(
      "ProcessReady",
      "false",
      "Timeout",
      `process ${name} did not reach running within ${this.#readinessTimeout}ms`,
    );
    return freezeClone(last);
  }

  #emit(
    type: SelfHostedProcessConditionType,
    status: "true" | "false" | "unknown",
    reason: string,
    message?: string,
  ): void {
    if (!this.#sink) return;
    this.#sink({
      type,
      status,
      reason,
      message,
      observedAt: this.#clock().toISOString(),
    });
  }
}
