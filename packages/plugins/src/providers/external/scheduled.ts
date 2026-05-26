/**
 * Cron-style scheduled trigger surface for the external profile.
 *
 * Wraps an operator-injected scheduler (systemd timers, cron, supervisord,
 * Nomad periodic jobs, etc.) so workloads can declare a `provider.external.scheduled@v1`
 * binding and receive an `enable / disable / runOnce / status` API.
 */
import { freezeClone } from "./common.ts";

export type ExternalScheduledState =
  | "active"
  | "paused"
  | "completed"
  | "unknown";

export interface ExternalScheduledRunner {
  ensure(spec: ExternalScheduledSpec): Promise<ExternalScheduledStatus>;
  disable(name: string): Promise<ExternalScheduledStatus>;
  runOnce?(input: ExternalScheduledRunOnceInput): Promise<void>;
  status(name: string): Promise<ExternalScheduledStatus | undefined>;
  list?(): Promise<readonly ExternalScheduledStatus[]>;
}

export interface ExternalScheduledSpec {
  readonly name: string;
  readonly cron?: string;
  readonly runAt?: string;
  readonly timezone?: string;
  readonly maxConcurrency?: number;
  readonly command: readonly string[];
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, string>;
}

export interface ExternalScheduledStatus {
  readonly name: string;
  readonly state: ExternalScheduledState;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastExitCode?: number;
  readonly metadata?: Record<string, string>;
}

export interface ExternalScheduledRunOnceInput {
  readonly name: string;
  readonly reason?: string;
}

export interface ExternalScheduledAdapterOptions {
  readonly runner: ExternalScheduledRunner;
  readonly clock?: () => Date;
}

export class ExternalScheduledAdapter {
  readonly #runner: ExternalScheduledRunner;
  readonly #clock: () => Date;

  constructor(options: ExternalScheduledAdapterOptions) {
    this.#runner = options.runner;
    this.#clock = options.clock ?? (() => new Date());
  }

  async enable(
    spec: ExternalScheduledSpec,
  ): Promise<ExternalScheduledStatus> {
    if (!spec.cron && !spec.runAt) {
      throw new Error(
        "external.scheduled: spec must declare cron or runAt",
      );
    }
    const status = await this.#runner.ensure(spec);
    return freezeClone(status);
  }

  async disable(name: string): Promise<ExternalScheduledStatus> {
    const status = await this.#runner.disable(name);
    return freezeClone(status);
  }

  async runOnce(input: ExternalScheduledRunOnceInput): Promise<void> {
    if (!this.#runner.runOnce) {
      throw new Error(
        "external.scheduled: injected runner does not support one-shot execution",
      );
    }
    await this.#runner.runOnce(input);
  }

  async status(name: string): Promise<ExternalScheduledStatus | undefined> {
    const status = await this.#runner.status(name);
    return status ? freezeClone(status) : undefined;
  }

  async list(): Promise<readonly ExternalScheduledStatus[]> {
    if (!this.#runner.list) return [];
    const items = await this.#runner.list();
    return items.map((item) => freezeClone(item));
  }

  observedAt(): string {
    return this.#clock().toISOString();
  }
}
