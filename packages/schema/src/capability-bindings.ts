/**
 * CapabilityBinding contract.
 *
 * Connections own external credentials at two scopes: `operator` (instance-wide
 * defaults) and `space`. An Installation binds each capability (compute / dns /
 * storage / source / database / secrets) to one of four modes:
 *
 *   - `default`    resolve to the operator default connection for the capability
 *   - `connection` resolve to an explicit (usually space-scoped) Connection
 *   - `manual`     no connection; the values are operator/user-provided data
 *   - `disabled`   the capability is not available to this Installation
 *
 * Resolution happens service-side; the vault still decides per-phase what a
 * resolved connection may mint.
 */

export type Capability =
  | "source"
  | "compute"
  | "dns"
  | "storage"
  | "database"
  | "secrets";

export type CapabilityBindingMode =
  | "default"
  | "connection"
  | "manual"
  | "disabled";

export interface CapabilityBinding {
  readonly mode: CapabilityBindingMode;
  /** Required when `mode === "connection"`. */
  readonly connectionId?: string;
  readonly provider?: string;
  readonly region?: string;
  /** Required when `mode === "manual"`. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Per-Installation capability binding map (`deployment_profiles`). */
export type CapabilityBindings = Readonly<
  Partial<Record<Capability, CapabilityBinding>>
>;

/**
 * Instance-wide operator default connection for one capability
 * (`operator_connection_defaults`).
 */
export interface OperatorConnectionDefault {
  readonly id: string;
  readonly capability: Capability;
  readonly provider: string;
  readonly connectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
