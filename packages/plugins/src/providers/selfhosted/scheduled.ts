/**
 * Cron-style scheduled trigger surface for the self-hosted profile.
 *
 * Wraps an operator-injected scheduler (systemd timers, cron, supervisord,
 * Nomad periodic jobs, etc.) so workloads can declare a `provider.selfhosted.scheduled@v1`
 * binding and receive an `enable / disable / runOnce / status` API.
 */
import { freezeClone } from "./common.ts";

export type SelfHostedScheduledState =
  | "active"
  | "paused"
  | "completed"
  | "unknown";

export interface SelfHostedScheduledRunner {
  ensure(spec: SelfHostedScheduledSpec): Promise<SelfHostedScheduledStatus>;
  disable(name: string): Promise<SelfHostedScheduledStatus>;
  runOnce?(input: SelfHostedScheduledRunOnceInput): Promise<void>;
  status(name: string): Promise<SelfHostedScheduledStatus | undefined>;
  list?(): Promise<readonly SelfHostedScheduledStatus[]>;
}

export interface SelfHostedScheduledSpec {
  readonly name: string;
  readonly cron?: string;
  readonly runAt?: string;
  readonly timezone?: string;
  readonly maxConcurrency?: number;
  readonly command: readonly string[];
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedScheduledStatus {
  readonly name: string;
  readonly state: SelfHostedScheduledState;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastExitCode?: number;
  readonly metadata?: Record<string, string>;
}

export interface SelfHostedScheduledRunOnceInput {
  readonly name: string;
  readonly reason?: string;
}

export interface SelfHostedScheduledAdapterOptions {
  readonly runner: SelfHostedScheduledRunner;
  readonly clock?: () => Date;
}

export class SelfHostedScheduledAdapter {
  readonly #runner: SelfHostedScheduledRunner;
  readonly #clock: () => Date;

  constructor(options: SelfHostedScheduledAdapterOptions) {
    this.#runner = options.runner;
    this.#clock = options.clock ?? (() => new Date());
  }

  async enable(
    spec: SelfHostedScheduledSpec,
  ): Promise<SelfHostedScheduledStatus> {
    if (!spec.cron && !spec.runAt) {
      throw new Error(
        "selfhosted.scheduled: spec must declare cron or runAt",
      );
    }
    const status = await this.#runner.ensure(spec);
    return freezeClone(status);
  }

  async disable(name: string): Promise<SelfHostedScheduledStatus> {
    const status = await this.#runner.disable(name);
    return freezeClone(status);
  }

  async runOnce(input: SelfHostedScheduledRunOnceInput): Promise<void> {
    if (!this.#runner.runOnce) {
      throw new Error(
        "selfhosted.scheduled: injected runner does not support one-shot execution",
      );
    }
    await this.#runner.runOnce(input);
  }

  async status(name: string): Promise<SelfHostedScheduledStatus | undefined> {
    const status = await this.#runner.status(name);
    return status ? freezeClone(status) : undefined;
  }

  async list(): Promise<readonly SelfHostedScheduledStatus[]> {
    if (!this.#runner.list) return [];
    const items = await this.#runner.list();
    return items.map((item) => freezeClone(item));
  }

  observedAt(): string {
    return this.#clock().toISOString();
  }
}
