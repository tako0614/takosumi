/**
 * The one declaration of the platform worker's bindings (operator first-run aid
 * and release authority).
 *
 * The platform worker requires ~a dozen durable bindings (D1 ×2, R2 ×4,
 * Durable Objects ×3 and the dashboard ASSETS). A `wrangler deploy` succeeds
 * even when one is missing, so a misconfigured operator only discovers it when
 * a real install/apply fails deep in the run pipeline. This names them up front
 * so `/readyz` fails loudly instead.
 *
 * WHY IT IS A TABLE AND NOT A LIST. This module was the authority in name only:
 * four artifacts each carried their own copy of "the bindings", and no two
 * agreed. The release gate's list held six names and neither R2 nor the Durable
 * Objects. The shipped OSS template omitted `HOSTED`, so the template this
 * repository ships could not satisfy its own release gate. The local-substrate
 * runner enumerated a third set. `scripts/check-platform-bindings.ts` imported
 * this module, printed a checklist, and was in no package script, so nothing
 * ever compared them.
 *
 * So each binding declares which artifacts must contain it, and
 * `check-platform-bindings.ts --check` projects this table onto every one of
 * them. Adding a binding is one edit here; forgetting to wire it anywhere is a
 * gate failure rather than a runtime surprise.
 *
 * It validates PRESENCE (the binding object exists on `env`), not liveness — it
 * never touches D1/R2/DO so it is cheap and side-effect-free. ASSETS is treated
 * as required for the platform worker (it serves the dashboard SPA); an
 * API-only deploy that intentionally omits ASSETS can pass `requireAssets:
 * false`.
 *
 * Commercial host-extension handlers are NOT part of OSS/operator readiness.
 * A host may contribute route descriptors and resolve its own handler keys in
 * an outer composition layer; OSS never names or hardcodes those handlers.
 */

/**
 * Where a binding must appear.
 *
 * - `readiness` — `checkPlatformBindings`, i.e. `/readyz`. Absent ⇒ 503.
 * - `ossTemplate` — `deploy/platform/wrangler.toml`, the shipped reference.
 * - `localSubstrate` — the Miniflare runner used by the local stack.
 * - `officialRelease` — the binding closure the platform release reads back off
 *   the immutable Worker Version before it will call a release ready.
 */
export type PlatformBindingList =
  | "readiness"
  | "ossTemplate"
  | "localSubstrate"
  | "officialRelease";

export type PlatformBindingKind =
  | "d1"
  | "r2"
  | "durableObject"
  | "assets"
  | "service"
  | "version_metadata"
  | "secret_text";

export interface PlatformBindingDeclaration {
  readonly kind: PlatformBindingKind;
  readonly lists: readonly PlatformBindingList[];
  readonly why: string;
  /** Durable Object class, where the artifact names one. */
  readonly className?: string;
}

export const PLATFORM_BINDINGS: {
  readonly [name: string]: PlatformBindingDeclaration;
} = {
  TAKOSUMI_ACCOUNTS_DB: {
    kind: "d1",
    lists: ["readiness", "ossTemplate", "localSubstrate", "officialRelease"],
    why: "Accounts plane store: session, OIDC, PAT and billing support data.",
  },
  TAKOSUMI_CONTROL_DB: {
    kind: "d1",
    lists: ["readiness", "ossTemplate", "localSubstrate", "officialRelease"],
    why: "The OpenTofu Capsule ledger: runs, state versions, outputs.",
  },
  R2_ARTIFACTS: {
    kind: "r2",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "Deploy-control plan and state artifacts.",
  },
  R2_SOURCE: {
    kind: "r2",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "Immutable per-snapshot source archives written by a source_sync run.",
  },
  R2_STATE: {
    kind: "r2",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "The OpenTofu state backend.",
  },
  R2_BACKUPS: {
    kind: "r2",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "Sealed control/state/service-data backup bundles. Required, not optional: a composition without it cannot take the backup its own recovery path assumes.",
  },
  COORDINATION: {
    kind: "durableObject",
    className: "CoordinationObject",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "Coordination leases and alarms for the deploy-control plane.",
  },
  RUN_OWNER: {
    kind: "durableObject",
    className: "OpenTofuRunOwnerObject",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "Per-run execution owner: dispatch, retry and terminal failure handling.",
  },
  RUNNER: {
    kind: "durableObject",
    // The local substrate proxies the runner instead of running a container,
    // so the class differs there; the binding NAME is what must agree.
    className: "OpenTofuRunnerObject",
    lists: ["readiness", "ossTemplate", "localSubstrate"],
    why: "The OpenTofu run executor, container-backed in a real deployment.",
  },
  ASSETS: {
    kind: "assets",
    lists: ["readiness", "ossTemplate", "officialRelease"],
    why: "Dashboard SPA assets. The local substrate serves the dashboard separately, so it does not bind them.",
  },
  TAKOSUMI_VERSION_METADATA: {
    kind: "version_metadata",
    lists: ["ossTemplate", "officialRelease"],
    why: "Cloudflare version metadata. Not a readiness binding: it is provided by the platform, not provisioned by the operator, and is absent under Miniflare.",
  },
  HOSTED: {
    kind: "service",
    lists: ["officialRelease"],
    why: "The operator's private extension service binding. Deliberately absent from the OSS template and the local substrate: OSS names no closed handler as a dependency, and the release gate reads it back only for the official composition.",
  },
  TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY: {
    kind: "secret_text",
    lists: ["officialRelease"],
    why: "Host key for the runtime-binding derivation lane. A secret, so it is never in a committed config; absent, the composition is on the declared sealed lane and /readyz says so.",
  },
  TAKOSUMI_ACCOUNTS_EXPORTS: {
    kind: "r2",
    lists: [],
    why: "Bound by the operator's realized staging and production configs and read by no code in this repository. Declared here so it is a known fact rather than a binding that appears in no list; the gate asserts it stays out of every artifact until something reads it.",
  },
};

/** Required binding names, grouped by kind, for the platform worker. */
export const REQUIRED_PLATFORM_BINDINGS = {
  d1: platformBindingNames("readiness", "d1"),
  r2: platformBindingNames("readiness", "r2"),
  durableObjects: platformBindingNames("readiness", "durableObject"),
  assets: platformBindingNames("readiness", "assets"),
} as const;

/** The names one artifact must contain, optionally narrowed to one kind. */
export function platformBindingNames(
  list: PlatformBindingList,
  kind?: PlatformBindingKind,
): readonly string[] {
  return Object.entries(PLATFORM_BINDINGS)
    .filter(
      ([, declaration]) =>
        declaration.lists.includes(list) &&
        (kind === undefined || declaration.kind === kind),
    )
    .map(([name]) => name);
}

export interface BindingCheckResult {
  readonly ok: boolean;
  /** Binding names that are absent from `env`, in declaration order. */
  readonly missing: readonly string[];
}

/**
 * Validates that every required platform binding is present on `env`. Returns
 * the named missing bindings (empty when fully configured).
 */
export function checkPlatformBindings(
  env: Record<string, unknown>,
  options: {
    readonly requireAssets?: boolean;
  } = {},
): BindingCheckResult {
  const requireAssets = options.requireAssets ?? true;
  const required = platformBindingNames("readiness").filter(
    (name) => requireAssets || PLATFORM_BINDINGS[name]?.kind !== "assets",
  );
  const missing = required.filter(
    (name) => env[name] === undefined || env[name] === null,
  );
  return { ok: missing.length === 0, missing };
}
