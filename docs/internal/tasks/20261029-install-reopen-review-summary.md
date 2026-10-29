# TASK-0118: retain the install review on reopen

- Owner/repository: Takosumi only, incumbent install UI writer. Stack on
  `feature/apps-without-workspace-ui-20261028` (#662); publish the fix PR with
  that base. Integrate current `origin/main` by ordinary merge. Do not merge
  PRs, deploy, or access live databases, providers, sign-in, or payment systems.
- Finding: a GET-only reopen of a reviewable attempt loses the connection and
  settings presentation because only `provide_inputs` previously populated
  the dashboard's retained sheet. The stored Plan is not claimed to be lost.
- Authority/security boundary: derive a read-only `reviewSummary` from retained
  attempt facts, InstallConfig, and committed bindings. Return public setting
  values only when captured trusted presentation proves them non-sensitive.
  Sensitive and generic settings expose a name and set marker only. No new
  database columns, secret copies, browser storage, or value-bearing URLs.
- UI: GET hydration has no mutation side effects. The chosen connection,
  Interface link choices, and public settings remain visible. Editing follows
  the existing discard-and-replan path; public values remain in component
  memory, while write-only settings must be entered again after reopening.
- Historical provenance: do not claim an automatic provider selection when
  existing persisted records cannot distinguish it from an explicit answer.
- Validation: server/unit/controller regressions; portable browser reopen at
  390px and desktop with screenshot inspection; touched static gate phases.
  The operator explicitly forbids the local complete gate/full test suite
  because the shared SSD is nearly full. CI must pass `check and test` on the
  final PR head. Stop if `/root/dev` has less than 1.5 GB free; promptly remove
  only this task's generated outputs. Use Bun 1.4.0 and SSD temporary paths.
- Reversal: revert this code and documentation change; persisted data and the
  existing Plan/Apply authority are unchanged. No schema/data migration.

## Local evidence

- Service regressions: 84 passed, including an accepted repository's public
  input through actual planning and reviewable GET responses, and GET/list
  mutation counters. Generic/sensitive rows return presence markers only.
- Dashboard/API focused tests: 68 passed; their isolated reactive controller
  fixture runs 60 tests. Meaningful RED cases covered missing GET hydration
  and stale predecessor summary when the replacement fails before inputs.
- Docs and portable harness regressions: 48 passed. Portable browser reopen:
  1 passed. The same URL remounts the page without mutations; provider/account,
  public setting, and secret set marker remain visible. Desktop and 390px
  screenshots were visually inspected, then task-owned outputs were removed.
- Root, Worker, and dashboard type checks, source format, generalization,
  unreferenced exports, import/test boundaries, authoritative docs, and contract
  package checks passed. This repository has no format writer or separate
  lint command; the portable gate's static boundary checks are used directly.
- Independent review found and closed a stale-summary edge after explicit Edit:
  the replacement now obtains its own sheet and retains only public drafts.
- Main integration preserves the upstream retirement of the obsolete Source
  revision updater; its deleted helper/API is not restored by the stack merge.

Final review follow-up: enrich only committed connection IDs with personal labels
owned by the current app owner, checking ownership again after the reads. Do not
list the owner's connection inventory. Resolve selected Interface names within
the plan's Workspace and expose an optional display label to the review sheet.
Presentation reads fail independently: missing reviewed config omits settings,
missing binding set omits connections, missing base config redacts setting
values, and missing labels retain committed IDs. Canonical attempt authorization
and its GET-only behavior remain outside these optional read error boundaries.
The accepted presentation requires an existing matching base config before any
public value is returned. Propagate #662 normally and use focused tests/static
checks locally; the full gate runs in CI under the shared SSD limit.
