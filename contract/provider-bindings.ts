/**
 * ProviderBinding contract.
 *
 * Connections own external credentials at two scopes: `operator` (Takosumi
 * provided defaults) and `space` (user env sets or helper-created credentials).
 * An Installation binds each required OpenTofu provider, optionally with the
 * exact alias the child module expects, to one of four modes:
 *
 *   - `default`    resolve to the Takosumi-provided default for the provider
 *   - `connection` resolve to an explicit Connection
 *   - `manual`     no connection; values become module inputs, never credentials
 *   - `disabled`   the provider is unavailable to this Installation
 *
 * Takosumi does not classify provider use into compute/dns/storage buckets.
 * Provider aliases are OpenTofu names only, not product categories.
 */

export type ProviderBindingMode =
  | "default"
  | "connection"
  | "manual"
  | "disabled";

export interface ProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly mode: ProviderBindingMode;
  /** Required when `mode === "connection"`. */
  readonly connectionId?: string;
  readonly region?: string;
  /** Required when `mode === "manual"`. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Per-Installation provider binding list (`deployment_profiles`). */
export type ProviderBindings = readonly ProviderBinding[];

/**
 * Instance-wide Takosumi-provided default connection for one OpenTofu provider
 * (`operator_connection_defaults` physical table).
 */
export interface OperatorConnectionDefault {
  readonly id: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Non-secret projection of "can this instance's managed default (operator key)
 * cover an install with NO Space connection configured?".
 *
 * A `default`-mode ProviderBinding resolves to the instance-wide operator
 * default connection for that provider (spec §7.1 `takosumi_managed`), so an
 * empty ProviderBindings list (the no-config install path) ALWAYS resolves to
 * `default` and falls through to the operator key. This projection answers the
 * dashboard's "do I need to connect my own cloud first?" question without
 * touching binding resolution.
 *
 * It is a DELIBERATELY narrow, credential-free signal: `available` is true when
 * the instance has at least one operator default connection, and `providers`
 * lists ONLY the provider source names those defaults cover. It carries NO
 * connection id, NO connection value, and NO secret material — the operator
 * default's id / connectionId stay on the bearer-gated §30 surface.
 */
export interface ManagedDefaultStatus {
  /** True when the instance has at least one operator default connection. */
  readonly available: boolean;
  /**
   * The OpenTofu provider source names the managed default covers (one per
   * operator default), sorted and de-duplicated. Never a credential.
   */
  readonly providers: readonly string[];
}
