const common = {
  provenance: "binds one clean merged source commit, protected pathless stage target, exact canonical platform config and existing Accounts/Control/R2/remote DO resources, artifact digest and separately pinned private secret custody; refuses production Worker, issuer, callbacks and caller target overrides",
  "post-conditions": "requires exact immutable Version bindings and canonical DO namespace IDs, one 100-percent serving Version and unchanged topology; after domain activation checks issuer discovery, public ES256 JWKS and exact-v5/predeployed readiness on that Version; authenticated browser/RP E2E remains a separate launch requirement",
  reversal: "preserves the serving predecessor Version; explicit owner restore is valid only with separately verified schema and authority compatibility; an applied schema is forward-only, and domain failure retains the closed stage target for explicit repair without production reassignment",
  "failure-handling": "fails closed before mutation on target/source/custody/schema/authority/topology mismatch; after any attempted mutation reports incomplete with known Version/predecessor identities, requires provider history reconciliation, and never automatically retries, deletes a Worker or restores durable data",
};

export const AUTH_STAGING_RELEASE_SURFACES = [
  {
    surface: "takosumi-auth-staging-bootstrap", target: "cloudflare-worker:takosumi-auth-staging", lineage: "integration", triggers: ["irreversible", "authority"],
    obligations: { ...common,
      "pre-mutation-proof": "requires an absent exact stage Worker and an independently reviewed target/artifact confirmation; creates only a sealed deny-all inert Worker with zero DB/secret bindings, disabled workers.dev/previews and no routes, never overwrites an existing Worker",
      "independent-review": "requires a named independent reviewer and the exact stage plan confirmation before the first inert Worker/topology creation",
    },
  },
  {
    surface: "takosumi-auth-staging-authority", target: "cloudflare-worker:takosumi-auth-staging", lineage: "integration", triggers: ["authority"],
    obligations: { ...common,
      "independent-review": "requires independent review of the exact stage registration, source/config/artifact and private secret bundle digest; strict Accounts-v5 and canonical Control read-only proofs precede configuration activation; domain routing stays disabled",
    },
  },
  {
    surface: "takosumi-auth-staging-code", target: "cloudflare-worker:takosumi-auth-staging", lineage: "integration", triggers: [], obligations: common,
  },
  {
    surface: "takosumi-auth-staging-topology", target: "cloudflare-worker-domain:auth-staging.takos.jp", lineage: "integration", triggers: ["irreversible", "authority"],
    obligations: { ...common,
      "pre-mutation-proof": "requires exact Accounts-v5 and canonical Control-v72 schema/fence proofs, qualified immutable fetch/scheduled Version and authority closure, disabled workers.dev/previews and zero routes/domains; configures and reads back only the approved one-minute retry cron before one explicit custom-domain attach, or adopts that exact previously applied cron read-only after an explicit recovery invocation",
      "independent-review": "requires a named independent reviewer and exact source/config/artifact/target/cron confirmation for this stage-only schedule and domain attachment; production auth.takos.jp is outside every selector",
    },
  },
  {
    surface: "takosumi-accounts-d1-schema-staging", target: "cloudflare-d1:canonical-staging-accounts", lineage: "integration", triggers: ["irreversible", "authority"],
    obligations: {
      provenance: "derives the exact existing Accounts D1 ID from the qualified canonical staging config and fixes environment/source before delegating the sole Accounts migration CLI and immutable catalog",
      "pre-mutation-proof": "apply requires independent review and a recorded production-shape rehearsal digest; canonical CLI also requires private backup/Time Travel evidence and exact source/catalog/target/config confirmations; caller target/environment overrides are rejected",
      "independent-review": "requires a named independent reviewer of the exact additive transition, rehearsal and protected target before apply; no schema change runs through code/config/topology surfaces",
      "post-conditions": "preserves the canonical CLI structural and ledger report; strict shared-profile activation is a later independent authority step and accepts only exact checksummed Accounts v5",
      reversal: "protected Accounts migrations are additive and forward-only; retain ordinary reviewed v4/v5-compatible bridge while profile is off, then verified v5 before activation; no destructive reset, down migration or database restore is exposed",
      "failure-handling": "preserves the owner CLI exit code and redacted report; stops on source/target/config/schema mismatch, and any partial/lost-ACK transition uses canonical read-only reconciliation and forward repair without blind retry",
    },
  },
] as const;
