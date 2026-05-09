import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare Custom Hostname / Custom Domain materialization.
 *
 * Descriptor: `provider.cloudflare.custom-domain@v1`
 *
 * Consumes the routes from a `RuntimeDesiredState`, attaches each external
 * hostname to a Cloudflare zone via the Custom Hostname API, and refreshes
 * the SSL bundle. Operators inject a client that wraps `POST
 * /zones/:id/custom_hostnames`, `PATCH .../ssl`, and `GET .../ssl/verify`.
 */

export type CloudflareCustomHostnameStatus =
  | "pending"
  | "active"
  | "active-redeploying"
  | "moved"
  | "pending-deletion"
  | "deleted"
  | "pending-blocked"
  | "pending-migration"
  | "pending-provisioned"
  | "test-pending"
  | "test-active"
  | "test-active-apex"
  | "test-blocked"
  | "test-failed"
  | "provisioned"
  | "blocked";

export type CloudflareCustomHostnameSslMethod =
  | "http"
  | "txt"
  | "email";

export interface CloudflareCustomHostnameSpec {
  readonly hostname: string;
  readonly originHostname?: string;
  readonly sslMethod?: CloudflareCustomHostnameSslMethod;
  readonly customOriginServer?: string;
  readonly bundleMethod?: "ubiquitous" | "optimal" | "force";
  readonly type?: "dv";
}

export interface CloudflareCustomHostnameSslState {
  readonly status: CloudflareCustomHostnameStatus;
  readonly method: CloudflareCustomHostnameSslMethod;
  readonly validationRecords?: readonly Record<string, string>[];
  readonly certificateAuthority?: string;
  readonly issuer?: string;
  readonly expiresAt?: string;
}

export interface CloudflareCustomHostnameRecord {
  readonly id: string;
  readonly hostname: string;
  readonly status: CloudflareCustomHostnameStatus;
  readonly ssl: CloudflareCustomHostnameSslState;
  readonly createdAt: string;
  readonly verificationErrors?: readonly string[];
}

export interface CloudflareCustomDomainMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly hostnames: readonly CloudflareCustomHostnameSpec[];
  readonly zoneId: string;
  readonly accountId?: string;
  readonly requestedAt: string;
  /**
   * Phase 18.2 H7: cancellation signal used by the deploy lifecycle to abort
   * a long-running SSL validation when the deployment transitions to
   * `failed` / `rolled-back` (or the user removes the route from manifest
   * mid-provision). Implementations are expected to:
   *   1. Stop polling Cloudflare for SSL validation as soon as the signal
   *      fires.
   *   2. Throw the matching `AbortError` so callers can surface the abort
   *      to their cleanup pipeline.
   * The kernel-side materializer detects the abort and runs
   * {@link CloudflareCustomDomainProviderMaterializer.cleanupInFlight} which
   * releases any reservation held in the registry and deletes the
   * partially-provisioned Cloudflare custom hostname so the zone does not
   * accumulate orphaned entries.
   */
  readonly signal?: AbortSignal;
}

export interface CloudflareCustomDomainMaterializationResult {
  readonly hostnames: readonly CloudflareCustomHostnameRecord[];
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareCustomDomainClient {
  ensureCustomHostname(input: {
    readonly zoneId: string;
    readonly spec: CloudflareCustomHostnameSpec;
  }): Promise<CloudflareCustomHostnameRecord>;
  getCustomHostname(input: {
    readonly zoneId: string;
    readonly hostname: string;
  }): Promise<CloudflareCustomHostnameRecord | undefined>;
  refreshSsl(input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<CloudflareCustomHostnameSslState>;
  verify(input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<CloudflareCustomHostnameRecord>;
  deleteCustomHostname(input: {
    readonly zoneId: string;
    readonly hostnameId: string;
  }): Promise<boolean>;
  materializeHostnames(
    input: CloudflareCustomDomainMaterializationInput,
  ): Promise<CloudflareCustomDomainMaterializationResult>;
}

/**
 * Reservation port used by the Cloudflare custom domain materializer to
 * serialize hostname ownership across tenants. Operators inject either an
 * in-process registry service or an HTTP client wrapping the internal custom
 * domain registry route.
 */
export interface CustomDomainRegistryClient {
  reserve(input: {
    readonly hostname: string;
    readonly tenantId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  }): Promise<void>;
  release(input: {
    readonly hostname: string;
    readonly tenantId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  }): Promise<void>;
}

export interface CloudflareCustomDomainProviderOptions {
  readonly client: CloudflareCustomDomainClient;
  readonly zoneId: string;
  readonly accountId?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extractHostnames?: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareCustomHostnameSpec[];
  /**
   * Custom domain registry client. When provided, the materializer reserves
   * each hostname before calling Cloudflare and releases the reservation when
   * a deployment is rolled back / uninstalled. Cross-tenant collisions
   * surface as `conflict` errors raised from {@link reserve}.
   */
  readonly registry?: CustomDomainRegistryClient;
  /**
   * Resolves the tenant identifier from a `RuntimeDesiredState`. Defaults to
   * `desiredState.spaceId`. Hosts that map tenants to a different field can
   * override (e.g. spaces that share a single tenant id should still resolve
   * to the same value so reservations remain per-tenant).
   */
  readonly resolveTenantId?: (
    desiredState: RuntimeDesiredState,
  ) => string;
}

export class CloudflareCustomDomainProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareCustomDomainClient;
  readonly #zoneId: string;
  readonly #accountId?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareCustomHostnameSpec[];
  readonly #registry?: CustomDomainRegistryClient;
  readonly #resolveTenantId: (
    desiredState: RuntimeDesiredState,
  ) => string;

  constructor(options: CloudflareCustomDomainProviderOptions) {
    this.#client = options.client;
    this.#zoneId = options.zoneId;
    this.#accountId = options.accountId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extract = options.extractHostnames ??
      defaultExtractCustomHostnames;
    this.#registry = options.registry;
    this.#resolveTenantId = options.resolveTenantId ??
      ((desiredState) => desiredState.spaceId);
  }

  async materialize(
    desiredState: RuntimeDesiredState,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const hostnames = this.#extract(desiredState);
    const signal = options.signal;
    if (signal?.aborted) {
      throw cloneAbortReason(signal);
    }
    // Cross-tenant collision detection: reserve each hostname in the kernel
    // registry before mutating Cloudflare. A hostname already owned by a
    // different (tenant, group, deployment) triple causes `reserve()` to
    // throw `conflict`, which short-circuits the apply. The deploy plan
    // surfaces it as HTTP 409 to the caller.
    const reservedHostnames: CloudflareCustomHostnameSpec[] = [];
    if (this.#registry) {
      const tenantId = this.#resolveTenantId(desiredState);
      for (const spec of hostnames) {
        if (signal?.aborted) {
          // Roll back any reservation acquired in this loop before returning
          // so the zone does not retain a half-claimed hostname.
          await this.#releaseSpecs(desiredState, reservedHostnames);
          throw cloneAbortReason(signal);
        }
        await this.#registry.reserve({
          hostname: spec.hostname,
          tenantId,
          groupId: desiredState.groupId,
          deploymentId: desiredState.id,
        });
        reservedHostnames.push(spec);
      }
    }
    let result: CloudflareCustomDomainMaterializationResult;
    try {
      result = await this.#client.materializeHostnames({
        desiredState: structuredClone(desiredState),
        hostnames,
        zoneId: this.#zoneId,
        accountId: this.#accountId,
        requestedAt: startedAt,
        signal,
      });
    } catch (err) {
      // SSL validation can take 30-60s. If the deploy lifecycle aborts the
      // signal mid-way (manifest edit removed the route, deployment marked
      // `failed`/`rolled-back`), tear down any partial Cloudflare state and
      // release the reservation so the hostname can be re-claimed cleanly.
      if (isAbortLike(err, signal)) {
        await this.cleanupInFlight({
          desiredState,
          hostnames: reservedHostnames,
        });
      }
      throw err;
    }
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-custom-domain-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      command: [
        "cloudflare",
        "custom-hostnames",
        "apply",
        "--zone",
        this.#zoneId,
      ],
      details: {
        accountId: this.#accountId,
        zoneId: this.#zoneId,
        hostnameCount: result.hostnames.length,
        hostnames: result.hostnames.map((h) => ({
          id: h.id,
          hostname: h.hostname,
          status: h.status,
          sslStatus: h.ssl.status,
        })),
      },
      recordedAt: completedAt,
      execution: {
        status: result.stderr ? "failed" : "succeeded",
        code: result.stderr ? 1 : 0,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
        completedAt,
      },
    };
    this.#operations.push(operation);
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      createdByOperationId: operation.id,
      operations: [operation],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  /**
   * Release every reservation owned by `desiredState`. Called by the rollback
   * / uninstall pipeline. Hosts without a configured registry no-op.
   */
  async releaseReservations(desiredState: RuntimeDesiredState): Promise<void> {
    await this.#releaseSpecs(desiredState, this.#extract(desiredState));
  }

  /**
   * Phase 18.2 H7 cleanup hook. Invoked when a deployment is cancelled while
   * SSL validation is still in flight (manifest edit removed the route,
   * deployment marked `failed`/`rolled-back`). Releases any reservation held
   * in the registry and asks Cloudflare to delete the half-provisioned
   * custom hostname so the zone does not accumulate orphaned entries.
   *
   * Errors raised by individual delete calls are recorded but do not abort
   * the cleanup loop — every reservation MUST be released before returning,
   * otherwise the hostname would stay locked and a follow-up deploy would
   * hit a `conflict` from the registry.
   */
  async cleanupInFlight(input: {
    readonly desiredState: RuntimeDesiredState;
    readonly hostnames?: readonly CloudflareCustomHostnameSpec[];
  }): Promise<void> {
    const specs = input.hostnames ?? this.#extract(input.desiredState);
    const errors: unknown[] = [];
    // Best-effort upstream delete: drops the half-provisioned custom hostname
    // from the Cloudflare zone. The CF Custom Hostname API expects a
    // hostname id; production wiring uses `getCustomHostname` (or the host
    // adapter's local mirror) to translate hostname -> id. Adapters that
    // cannot resolve an id no-op gracefully.
    for (const spec of specs) {
      try {
        const record = await this.#client.getCustomHostname?.({
          zoneId: this.#zoneId,
          hostname: spec.hostname,
        });
        if (record?.id) {
          await this.#client.deleteCustomHostname({
            zoneId: this.#zoneId,
            hostnameId: record.id,
          });
        }
      } catch (err) {
        errors.push(err);
      }
    }
    // Reservation release runs unconditionally, even when a delete failed,
    // so the next deploy attempt can re-claim the hostname.
    try {
      await this.#releaseSpecs(input.desiredState, specs);
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) {
      const message = errors.map((e) => `${e}`).join("; ");
      throw new Error(`custom domain cleanup partial failure: ${message}`);
    }
  }

  async #releaseSpecs(
    desiredState: RuntimeDesiredState,
    specs: readonly CloudflareCustomHostnameSpec[],
  ): Promise<void> {
    if (!this.#registry) return;
    const tenantId = this.#resolveTenantId(desiredState);
    for (const spec of specs) {
      await this.#registry.release({
        hostname: spec.hostname,
        tenantId,
        groupId: desiredState.groupId,
        deploymentId: desiredState.id,
      });
    }
  }
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err && typeof err === "object") {
    const e = err as { name?: string; code?: string };
    if (e.name === "AbortError") return true;
    if (e.code === "ABORT_ERR") return true;
  }
  return false;
}

function cloneAbortReason(signal: AbortSignal): unknown {
  // `signal.reason` carries the structured abort reason in modern runtimes.
  // Fall back to a plain `AbortError` if the runtime does not surface one.
  const reason = (signal as unknown as { reason?: unknown }).reason;
  if (reason !== undefined && reason !== null) return reason;
  const err = new Error("custom domain materialization aborted");
  err.name = "AbortError";
  return err;
}

function defaultExtractCustomHostnames(
  desiredState: RuntimeDesiredState,
): readonly CloudflareCustomHostnameSpec[] {
  const out: CloudflareCustomHostnameSpec[] = [];
  const seen = new Set<string>();
  for (const route of desiredState.routes) {
    const meta = route as unknown as {
      readonly hostname?: string;
      readonly host?: string;
      readonly originHostname?: string;
      readonly sslMethod?: CloudflareCustomHostnameSslMethod;
    };
    const hostname = meta.hostname ?? meta.host;
    if (!hostname) continue;
    if (seen.has(hostname)) continue;
    seen.add(hostname);
    out.push({
      hostname,
      originHostname: meta.originHostname,
      sslMethod: meta.sslMethod ?? "http",
    });
  }
  return out;
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
