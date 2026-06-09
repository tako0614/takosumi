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
