# CLI Surface Design

This document fixes the v1 surface of the `takosumi` CLI as a design artifact.
The reference at [`/reference/cli`](/reference/cli) records exactly which
commands and flags exist; this document records why the surface looks that way
and which boundaries the CLI must not cross.

## Authority boundary

The CLI is not the semantic authority for any kernel-side decision. The
authority lives in the kernel, scoped per Space. Every `takosumi` invocation is
a courier:

- The Space is never selected by a CLI flag or manifest field. Current public
  deploy binds the bearer token to one kernel-configured public deploy scope
  (`TAKOSUMI_DEPLOY_SPACE_ID`, default `takosumi-deploy`). Internal
  control-plane routes use actor/API/operator context for richer Space routing.
- The CLI loads the Manifest file as YAML or JSON and submits the resulting JSON
  manifest envelope to the kernel. Current public deploy validates and resolves
  Shape / Provider / Template references, builds a reference DAG, and then runs
  dry-run / apply / destroy through the kernel-owned deploy route. The richer
  `ResolutionSnapshot` → `DesiredSnapshot` → `OperationPlan` → WAL pipeline is
  the internal design model and must not be faked by the CLI.
- Connector ids of the form `connector:<id>` are operator-installed and resolved
  by the runtime-agent under kernel direction; the CLI does not interpret them.
- The CLI does not classify an Object's lifecycle (`managed` / `generated` /
  `external` / `operator` / `imported`), assign an access mode (one of the five
  enum values), or assert any of the 19 closed Risk codes. Those judgements
  arrive in the kernel response and are surfaced verbatim.
- The six numbered approval invalidation triggers are kernel-side concerns; the
  CLI may render them but never mutate them.

A malicious or buggy CLI cannot widen authority, only fail loudly.

## Local vs remote mode

`takosumi` runs against either a remote kernel or an in-process kernel.

- **Remote mode** is selected when a remote URL is resolved from `--remote`,
  `TAKOSUMI_REMOTE_URL`, or the config file. The CLI posts Manifests and
  DataAsset bytes to the kernel HTTP server, which owns persisted deploy
  records, idempotency replay, and artifact state. This is the only mode that
  maintains public deploy state across processes.
- **Local mode** is selected when no remote URL is resolved. The CLI spins up an
  in-process kernel against the bundled shape / provider registry, runs apply /
  plan / destroy, and discards state on exit.

Local mode is dev-only. It exists so authors can iterate on Manifests without
standing up a kernel and so test fixtures can exercise the apply pipeline
in-process. It does not persist a `ResolutionSnapshot` or `DesiredSnapshot`,
does not journal the `OperationPlan`, and does not provide multi-actor auth.
Endpoints whose contract is meaningless without persisted Space state (`status`,
`artifact …`) reject local mode with exit code 2 rather than degrade.

`takosumi server` is the bridge: starting it locally turns the same binary into
a full kernel host, after which the same CLI commands run in remote mode against
`http://localhost:<port>`.

## Command surface principles

The verb set is small and chosen by lifecycle, not by resource:

`server`, `deploy`, `plan`, `destroy`, `status`, `migrate`, `init`, `artifact`,
`runtime-agent`, `completions`, `version`.

Design rules:

- Every authoring verb (`deploy`, `plan`, `destroy`) takes a Manifest path as
  its single positional. The Manifest is the unit the kernel reasons about;
  per-resource subcommands would let the CLI assemble a partial DesiredSnapshot,
  which is forbidden.
- There is no top-level `apply` or `update`. `apply` is spelled `deploy`; the
  CLI always submits a whole Manifest to the kernel. Current public apply reuses
  prior resource outputs when the persisted public deploy record's fingerprint
  matches; richer DesiredSnapshot diffing remains kernel-internal design work.
  `--dry-run` selects the same `POST /v1/deployments` route with `mode: "plan"`,
  which is also why `plan` is a thin alias rather than a separate pipeline. Plan
  output includes the kernel-generated OperationPlan preview digests and WAL
  idempotency tuple preview; the CLI renders that payload but does not compute
  it.
- `destroy --force` covers the narrow case where a self-hosted resource handle
  equals its declared name and no apply record exists. It does not bypass
  kernel-side authority; it permits handle inference in the absence of state.
- `artifact` and `runtime-agent` are grouped subcommands because they address
  distinct kernel surfaces (DataAsset store, runtime-agent RPC) with their own
  bearer scopes.
- `init`, `completions`, `version` are pure local utilities with no network
  calls and no Space context.

## Config cascade

The CLI resolves remote URL and bearer token through a single fixed precedence:

1. explicit command flag (`--remote`, `--token`)
2. specific env (`TAKOSUMI_REMOTE_URL`, `TAKOSUMI_DEPLOY_TOKEN`,
   `TAKOSUMI_AGENT_TOKEN`)
3. generic / deprecated env aliases (`TAKOSUMI_TOKEN`, `TAKOSUMI_KERNEL_URL`)
4. config file `~/.takosumi/config.yml`
5. built-in default (none for URL / token; `8788` / `8789` for ports)

Env is the first persistent layer because it is the natural integration point
for shells, CI, and supervisors; the file exists to keep the single-host
operator from exporting env vars in their shell rc.

The config file's YAML schema is closed (`remote_url`, `token`). It is not a
place to express Space, profile, or routing decisions; those belong on the
kernel side. Closing the schema keeps the file from becoming a second source of
truth that drifts from the kernel's operator profile.

## Output Formats

The CLI emits command-specific stable output only. Commands whose primary
contract is machine consumption (`plan`, `artifact list`, `artifact kinds`
without `--table`) print JSON by default. Commands whose primary contract is
operator feedback (`deploy`, `destroy`, `status`, `server`) print concise text.

A global `--json` flag is not part of the current v1 CLI surface. Adding one
requires changing both the reference and every command test so stdout and stderr
stay deterministic.

Streaming output (live plan progression, interleaved log frames) is not part of
v1: a streamed plan cannot be cached or compared across invocations, breaking
idempotency reasoning in CI; and stream framing would introduce a third contract
surface drifting away from the HTTP JSON envelope.

Errors always render as the canonical envelope
`{ code, message,
requestId, details? }` when the upstream kernel returned one.
Local CLI precondition failures may render concise text until a command-specific
JSON surface exists.

## Exit code regime

Exit codes are a small reserved set:

- `0` — command succeeded.
- `1` — command-specific failure (kernel ≥ 400, plan / apply failure, partial
  destroy, migration failure, verify failure of a connector).
- `2` — usage or precondition error (malformed flag, missing required env,
  remote-only command without remote URL).
- `70+` — reserved for future signal-driven and host-driven exits, not currently
  emitted.

The 70+ band is reserved to stay aligned with `sysexits.h` (`EX_OSERR
= 71`,
`EX_IOERR = 74`, `EX_TEMPFAIL = 75`). We avoid the 64–69 sub-band so `2` keeps
its conventional "usage error" meaning and future host-class exits do not
collide with the small set users routinely handle.

## Deprecation policy design

The CLI prints at most one stderr warning per process per deprecated selector.
Three rules carry this:

- Warnings go to stderr, never stdout, so JSON-producing commands and pipelines
  stay byte-identical regardless of deprecation state.
- `TAKOSUMI_NO_DEPRECATION_WARN=1` suppresses every CLI deprecation warning at
  once. CI noise control is the explicit use case: an operator pinned to a
  known-deprecated env name during a migration window mutes the warning
  fleet-wide without per-flag overrides.
- The grace window for any deprecated alias is one CLI minor release: the minor
  that introduces a warning is the last that still resolves the alias; the next
  minor removes it.

## Security boundary

The bearer token lives only on the CLI side; the kernel never echoes one, and
the CLI never persists one on its behalf:

- Tokens are read from flag, env, or the config file the operator already owns.
  The CLI never writes tokens to disk, log files, or the config file.
- A token may be held in process memory for the duration of a single command. It
  may not be embedded in a Manifest, an emitted artifact, a DataAsset, or any
  structured output.
- `runtime-agent serve` may print a freshly-generated token to stdout exactly
  once when neither `--token` nor `TAKOSUMI_AGENT_TOKEN` is provided, because
  that is the only moment the operator can capture it. Subsequent invocations do
  not re-print a stored value.

This keeps the CLI host's compromise surface to "what is in the operator's shell
already", and keeps secrets out of any content-addressed artifact the kernel
might later store.

## Manifest preparation responsibility

Two sides share the work of turning a Manifest into a kernel-applicable state,
and the boundary is fixed:

- **CLI side** does content-address preparation of local source. `artifact push`
  hashes bytes, uploads them, and returns the `{ hash, kind, size, uploadedAt }`
  envelope; the operator embeds the hash into the Manifest. The CLI is the only
  component that sees raw local bytes; it never sends a path string into the
  kernel.
- **Kernel side** does namespace resolution. Shape ids, provider ids, template
  ids, connector ids, and DataAsset references resolve against the Space-scoped
  registry, not any CLI cache. The CLI must never invent a fallback when the
  kernel returns an unresolved reference.

DataAsset kinds are open strings discovered from the kernel registry. The CLI
does not extend or cache the list locally; `artifact kinds` exists so the CLI
can ask the kernel which kinds are currently registered.

## Related

- Reference: [CLI](/reference/cli),
  [DataAsset Kinds](/reference/artifact-kinds),
  [Environment Variables](/reference/env-vars), [Manifest](/manifest)
- Design:
  [Operation Plan and Write-ahead Journal Model](/design/operation-plan-write-ahead-journal-model)
