# 運用 Hardening チェックリスト {#operational-hardening-checklist}

このページは未完タスク表ではなく、reference / operator production profile が
満たすべき hardening requirements の一覧です。各 requirement
の実装状況は対応する reference docs / tests / release evidence で確認します。

## Space 隔離 {#space-isolation}

- Every Deployment, snapshot, journal, observation, approval, debt, activation,
  and GroupHead has a Space id.
- Space comes from deploy context / auth / API / operator profile.
- External publication paths are Space-scoped.
- Secrets, optional DataAssets, journals, approvals, observations, and audit
  events are Space-scoped.
- Publisher roots are defined by operator or product distributions, and concrete
  external publication paths are granted into Spaces.
- GroupHead identity is `spaceId + groupId`.

## Root 不変条件 {#root-invariants}

- ResolutionSnapshot and DesiredSnapshot are immutable.
- Apply uses recorded resolution evidence and snapshots instead of re-resolving
  catalog documents or external publication registries during provider effects.
- All graph entities have stable addresses.
- Lifecycle class restricts operation kinds.
- Core canonical state stores secret references, not raw secret values.
- Actual effects cannot exceed approved effects without pause / compensation /
  approval.
- Side-effecting operations are write-ahead journaled.
- Generated object ids are deterministic where possible.
- Apply and activation are separated.
- Observations append facts; desired state changes through new snapshots.
- Deployment destroy handles Takosumi-managed objects according to lifecycle
  policy.
- Production serializes critical mutations, Space publication sharing, and kind
  alias / descriptor / implementation binding set updates.

## Component kind resolution {#component-kind-resolution}

- Takosumi public concepts remain AppSpec, Installation, and Deployment.
- AppSpec root is only `apiVersion`, `metadata`, and `components`.
- Component public fields are only `kind`, `spec`, `publish`, and `listen`.
- Short kind aliases are operator-injected and fail closed when unresolved.
- Catalog entries, kind-specific input schemas, and implementation bindings are
  resolved and recorded before runtime use.

Reference / operator production profile:

- Execution targets come from the operator-selected binding set.
- runtime-agent or provider inventory drift is recorded as operator evidence,
  not as AppSpec vocabulary.

## External publication {#external-publications}

- External publication path grammar is enforced inside each Space.
- Shadowing is policy-gated, and production denies meaningful Space / operator /
  external shadowing by default.
- Default publications never imply admin access.
- Grant-producing publications require explicit access unless safe default is
  declared.
- ExternalPublicationDeclaration and PublicationMaterialization are separated.

## Journal と回復 {#journal-and-recovery}

- Operation intent is recorded before external calls.
- Generated object planned records are written before creation.
- External call start and observed handle are both journaled.
- RevokeDebt is created for failed cleanup.
- Journal entries with unresolved debt are not compacted away.

## Policy と approval {#policy-and-approval}

- Approvals bind to snapshot digest, operation plan digest, and effect details.
- Approval invalidation triggers are implemented per the closed v1 set in
  [Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md).
- Plan risks have stable risk ids and only emit kinds drawn from the closed v1
  Risk enum.
- Error hints are classified as safeFix, requiresPolicyReview, or operatorFix.

## シークレット {#secrets}

- Secret-bearing publications cannot project to plain env.
- Literal env secret scanning or policy is enabled.
- Runtime secrets are not passed to transforms by default.

## Activation {#activation}

- Ingress reservation and traffic assignment are separated.
- GroupHead update is serialized per Space.
- Rollback modes are explicit.

## Observability {#observability}

- Audit events include kind descriptor selections, resolution, desired adoption,
  link selection, operation stages, generated objects, debts, approvals,
  activation, and GroupHead.
- RevokeDebt is visible in operator status views and deploy gates. `/readyz`
  remains kernel control-plane readiness only.
