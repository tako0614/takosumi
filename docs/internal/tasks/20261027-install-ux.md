# Install UX: one app detail with inline configuration and connections

Owner: current DeckIDE writer. Takosumi only; base685aa726. Other worktrees,
launch receipts, credentials and active checks are preserved.

- Keep app identity visible during configuration, connections, Run and completion.
- Reuse immutable SourceSnapshot/InstallConfig input projections, ProviderConnection
  recipes and verification, and reviewed Plan/Apply authority. Store is presentation.
- Embed existing connection setup. Inputs stay mounted in memory, never serialized
  into URLs/storage. Provider credentials remain transient, write-only form values.
- Require verified policy-compatible connections before Plan. A deliberate Install
  continues only a clean non-destructive policy-pass Plan. Other approval remains
  explicit. Reload discovers existing server state and carries no Apply consent.
- Preserve only opaque recovery IDs. Fence late reads/mutations by Workspace/Capsule.
- Confirm Uninstall and honor existing two-stage DELETE, status and cancellation.
- Validate focused unit/browser tests, real local backend integration where feasible,
  desktop/mobile appearance, TypeScript/lint/build and `bun run check`. Fixture
  evidence is not production evidence. No production mutation is needed here.

Implemented:

- App identity stays on the selected detail while the first Install expands
  repository-compiled settings. Required fields and defaults are prominent;
  optional inputs, Git coordinates and technical information are disclosures.
- Existing ProviderConnection recipes, create/test/revoke and verified binding
  selection run inside a locally suspended panel. Closing returns keyboard focus;
  Workspace changes invalidate late requests. No invented provider support.
- The second Install uses the durable Git coordinator and existing Run engine.
  Clean Plans can continue only from that click; review/approval and destructive
  confirmation remain. Logs, partial-state re-plan and unknown-POST holds are real
  client API paths. Reload restores opaque IDs without restoring Apply consent.
- Authenticated Capsule/state/interface reads restore Open and management. Applied
  errors retain management and in-page repair. Uninstall shares dependency warnings,
  scheduled teardown/cancellation predicates and confirmation with app management.
- Removed redundant wizard/connection screens and copy. Updated both user guides.

Verification before final gate:

- Dashboard unit cohort: 803 passed, 0 failed (latest recorded unit-v4).
- New + existing focused browser cohort: 36 passed; final partial-state and mobile
  overflow changes: 8 passed. Fixture browser tests are not production evidence.
- Independent Claude source review: initial ten P2 findings preserved and fixed;
  v3 closes the final partial-state recovery P2 and stale handoff launch P3.
- Desktop/mobile screenshots inspected. Added control overflow and focus visibility
  assertions after visual inspection found clipped content under the sticky shell.
- Canonical `bun run check` follows on this candidate. Its recorded terminal receipt
  and final results live outside the product tree at
  `/root/dev/operator-runs/takosumi-install-ux-20261027/evidence/`.

Known existing limits: only recipes/providers installed by the owning backend are
shown. Secret-backed module inputs continue through the existing supported control
surface; UI does not bypass its restrictions. Uninstall means the existing scheduled
teardown, not instant erasure. Production publication is outside this change.
