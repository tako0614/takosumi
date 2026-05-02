/**
 * Router config reload + health surface for the self-hosted profile.
 *
 * The base `SelfHostedRouterConfigAdapter` (router.ts) renders Caddy / Traefik
 * config and writes it through an injected writer. In production we also need
 * to:
 *
 *   - validate the rendered config before writing (reject empty / malformed
 *     blocks early so a bad deploy doesn't break the running gateway)
 *   - reload the running router after writing (so changes take effect)
 *   - probe upstream targets so we don't black-hole traffic to a dead service
 *
 * The reloader / prober contracts are operator-injected; the controller below
 * orchestrates them with retry and condition emission.
 */
import { freezeClone } from "./common.ts";
import type { SelfHostedRouterKind } from "./router.ts";

export interface SelfHostedRouterReloader {
  reload(input: {
    readonly kind: SelfHostedRouterKind;
    readonly path?: string;
  }): Promise<{ readonly reloadedAt: string; readonly revision?: string }>;
}

export interface SelfHostedRouterHealthProbe {
  probe(input: {
    readonly host?: string;
    readonly path?: string;
    readonly target: string;
    readonly timeoutMs?: number;
  }): Promise<{
    readonly ok: boolean;
    readonly status?: number;
    readonly latencyMs?: number;
    readonly message?: string;
  }>;
}

export type SelfHostedRouterConditionType =
  | "RouterValidated"
  | "RouterReloaded"
  | "RouterHealthy";

export interface SelfHostedRouterCondition {
  readonly type: SelfHostedRouterConditionType;
  readonly status: "true" | "false" | "unknown";
  readonly reason?: string;
  readonly message?: string;
  readonly observedAt: string;
}

export type SelfHostedRouterConditionSink = (
  condition: SelfHostedRouterCondition,
) => void;

export interface SelfHostedRouterControllerOptions {
  readonly reloader?: SelfHostedRouterReloader;
  readonly healthProbe?: SelfHostedRouterHealthProbe;
  readonly clock?: () => Date;
  readonly conditionSink?: SelfHostedRouterConditionSink;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export class SelfHostedRouterController {
  readonly #reloader?: SelfHostedRouterReloader;
  readonly #probe?: SelfHostedRouterHealthProbe;
  readonly #clock: () => Date;
  readonly #sink?: SelfHostedRouterConditionSink;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;

  constructor(options: SelfHostedRouterControllerOptions = {}) {
    this.#reloader = options.reloader;
    this.#probe = options.healthProbe;
    this.#clock = options.clock ?? (() => new Date());
    this.#sink = options.conditionSink;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#sleep = options.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.#initialBackoffMs = options.initialBackoffMs ?? 100;
    this.#maxBackoffMs = options.maxBackoffMs ?? 2_000;
  }

  /**
   * Reject configs that are empty or contain trivially broken blocks. Returns
   * the validation issues; an empty array means the config is valid.
   */
  validate(content: string, kind: SelfHostedRouterKind): readonly string[] {
    const issues: string[] = [];
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      issues.push("config-empty");
    }
    if (kind === "caddy") {
      const open = (content.match(/\{/g) ?? []).length;
      const close = (content.match(/\}/g) ?? []).length;
      if (open !== close) issues.push("caddy-brace-mismatch");
    }
    if (kind === "traefik") {
      if (!/http:\s*\n/.test(content) && !/services:/.test(content)) {
        issues.push("traefik-missing-http-block");
      }
    }
    if (issues.length === 0) {
      this.#emit("RouterValidated", "true", "Validated");
    } else {
      this.#emit(
        "RouterValidated",
        "false",
        "InvalidConfig",
        issues.join(","),
      );
    }
    return freezeClone(issues);
  }

  async reload(
    kind: SelfHostedRouterKind,
    path?: string,
  ): Promise<
    { readonly reloadedAt: string; readonly revision?: string } | undefined
  > {
    if (!this.#reloader) {
      this.#emit(
        "RouterReloaded",
        "unknown",
        "NoReloader",
        "no reloader configured",
      );
      return undefined;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        const result = await this.#reloader.reload({ kind, path });
        this.#emit("RouterReloaded", "true", "Reloaded");
        return freezeClone(result);
      } catch (error) {
        lastError = error;
        if (attempt === this.#maxAttempts) {
          this.#emit(
            "RouterReloaded",
            "false",
            "ReloadFailed",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
        const delay = Math.min(
          this.#initialBackoffMs * 2 ** (attempt - 1),
          this.#maxBackoffMs,
        );
        await this.#sleep(delay);
      }
    }
    if (lastError) throw lastError;
    return undefined;
  }

  async probeTargets(
    targets: readonly {
      readonly host?: string;
      readonly path?: string;
      readonly target: string;
    }[],
    options: { readonly timeoutMs?: number } = {},
  ): Promise<
    readonly {
      readonly target: string;
      readonly host?: string;
      readonly ok: boolean;
      readonly status?: number;
      readonly latencyMs?: number;
      readonly message?: string;
    }[]
  > {
    if (!this.#probe) return [];
    const results = await Promise.all(
      targets.map(async (entry) => {
        try {
          const r = await this.#probe!.probe({
            host: entry.host,
            path: entry.path,
            target: entry.target,
            timeoutMs: options.timeoutMs,
          });
          return { target: entry.target, host: entry.host, ...r };
        } catch (error) {
          return {
            target: entry.target,
            host: entry.host,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const allOk = results.every((r) => r.ok);
    this.#emit(
      "RouterHealthy",
      allOk ? "true" : "false",
      allOk ? "AllTargetsHealthy" : "TargetUnhealthy",
      allOk
        ? undefined
        : results.filter((r) => !r.ok).map((r) => r.target).join(","),
    );
    return freezeClone(results);
  }

  #emit(
    type: SelfHostedRouterConditionType,
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
