# Sources and Capsules

Git is the single source of truth for Takosumi. Whatever is running corresponds to some
commit in some repository.

## Source

Each new install creates a Source owned exclusively by its app. Installing the same repository
again creates a different Source and sync Run. `ownerCapsuleId` identifies the owning app and
cannot be changed or removed once assigned. Install-plan-derived IDs let retries recover the
same Source after a lost acknowledgement.

A Source registered through `POST /sources` for preflight starts unowned. Initial app creation
claims it atomically; a Source owned or referenced by another app cannot be assigned to a new
app. Both install modes enable automatic polling when their plan becomes reviewable.

A Source declares that you want to follow this directory of this repository at this ref.

Only three things are required: the Workspace, a name, and a URL.

Put a [token you created](../reference/cli.md#creating-a-token) with `read` and `write` in
`$TAKOSUMI_DEPLOY_CONTROL_TOKEN` for these examples.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "ws_example",
    "name": "example-app",
    "url": "https://github.com/example/example-app.git",
    "defaultRef": "v1.2.0",
    "defaultPath": "deploy/opentofu"
  }'
```

| Field              | When omitted | Meaning                                                  |
| ------------------ | ------------ | -------------------------------------------------------- |
| `defaultRef`       | Git `HEAD`   | The branch, tag, or commit to track                      |
| `defaultPath`      | `.`          | Repository subtree captured, archived, and scanned       |
| `authConnectionId` | none         | The Connection used to read a private repository         |
| `autoSync`         | `false` (installs enable it when their plan is reviewable) | The operator's scheduler checks the Git ref periodically |

For an owned Source, `defaultRef` and `defaultPath` follow the app's adopted snapshot.
Apply, Restore, state recovery, revision creation, and reconciliation converge this lane
with an owner-and-state CAS. Public PATCH refuses lane changes with
`source_lane_owned_by_app`; use the app's revision flow. Reconciliation observes one lane
and settlement can mark only its owner stale. Backups also use the adopted snapshot.

Discarding an install attempt, uninstalling, or abandoning its app retires the Source.
Retirement stops sync admission and polling, waits for in-flight syncs, deletes its owned
archives, then atomically removes snapshot rows and the Source with `source.retired` Activity.
A daily sweep resumes interrupted cleanup. Destroyed apps remain readable after retirement.

The Git URL, ref, and source subtree are the Source acquisition coordinate.
There is no Takosumi-specific source catalog. `defaultPath` narrows the captured
tree but does not select an executable module. Source sync scans tracked regular
files under the source subtree at the exact commit and records the real OpenTofu
root modules and provider sources in the `SourceSnapshot`. Only this file-derived scan
creates module or provider candidates. What a module needs in order to be added is in
[Prepare a repository](../getting-started/prepare-repository.md).

The creation response carries a `hookSecret`. **It is returned in the clear exactly once,
at creation, and cannot be retrieved afterwards.** The Source record stores only a hash.
Configure the Git host webhook with `Authorization: Bearer <hookSecret>`. If you lose the
value, rotate the secret on the same Source; you do not need to delete and recreate it.

### Rotating a webhook secret

If leakage is suspected or the value is lost, prepare to update the Git host's webhook and
call this endpoint authenticated as an owner/admin of the Source's Workspace. This example also
uses `TAKOSUMI_DEPLOY_CONTROL_URL` for the Takosumi origin and puts an API key that
owner/admin created, with Read and Write, in `TAKOSUMI_DEPLOY_CONTROL_TOKEN`.
Any Workspace restriction on the PAT must also match the target Workspace. The
request has no body. On success it returns `200` and `Cache-Control: no-store`; the response's
`hookSecret` is shown in clear text only for this rotation.

```bash
curl --silent --show-error --fail-with-body -X POST \
  "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources/src_example/hook-secret/rotate" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Rotation has **no grace window for the old secret**. Read the response once on a controlled
terminal, then immediately update the forge (GitHub or another Git host) webhook's secret /
Authorization bearer with the new value. Never put the secret in a URL or query string, or write
it to logs, shell history, an Issue/PR/chat, or a file. Do not pipe the command through `tee`,
file capture, or log collection, and keep it out of terminal recording and screen sharing. After
updating the Git host, confirm that the new secret is accepted and the old one receives `401`.

Deliveries using the old secret between rotation and the forge update receive `401`, so changes
may be missed. If any were missed, follow the [manual SourceSnapshot sync](#sourcesnapshot-a-ref-is-not-a-commit)
below: call `POST /api/v1/sources/{sourceId}/sync` with `intent: manual_plan`, then confirm the
sync Run succeeded and produced a new snapshot before starting a plan.

The old secret is invalid for webhook requests verified after the rotation commits. A webhook
already authenticated, or a webhook/Run already in progress, is not canceled. Concurrent
rotations compare and commit atomically against the original Source and the Workspace's active
authority: only the winner receives a secret, and the loser gets `409` with no secret or mutation.
Each POST issues a fresh secret, so clients must never retry it automatically. If a success
response is lost, the secret cannot be retrieved; check the state and manually rotate again, then
configure the newly returned value at the Git host. The rotation activity records only the actor,
Source, and Workspace, never the secret.

## SourceSnapshot: a ref is not a commit

`defaultRef` says where to look, not what was executed. What actually runs is the commit
the ref resolved to, and that is stored as a SourceSnapshot.

If you point at a branch, the ref moves. **The SourceSnapshot a past Run points at does
not.** What you ran back then is always determined.

Synchronization is explicit.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources/src_example/sync" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "intent": "manual_plan" }'
```

There are two values for `intent`.

- `observe` (the default) — observation driven by a webhook or the scheduler. If a
  Capsule has opted in, this feeds the decision to update automatically
- `manual_plan` — a sync for a plan a person is going to read. The sync itself starts no
  other automatic update

Wait until the sync Run reaches `succeeded` and that Run's `snapshotId` appears
under `/api/v1/sources/{sourceId}/snapshots`, then move on to the compatibility check and
the plan. When the resolved commit matches the newest snapshot in the same Source ref/path
lane, the sync reuses that snapshot ID. Archive bytes and fetch provenance stay fixed;
only missing or invalid observations may be repaired. Valid manifest and module observations
remain fixed; a changed valid observation creates a new snapshot instead. An unused archive
uploaded for the current Run is deleted through its storage owner's custody path.
Archives are never reused across Sources. Use the ID returned by the Run.

Automatic polling orders Sources by their latest attempt or source_sync Run creation time,
including attempts that fail before creating a Run. Never-attempted Sources come first, with
a default batch of 25. Sources outside active Workspaces and already observed commit pins are
excluded. Permanently invalid Git coordinates or applied lineage mark the Source `error`; repair its configuration
and restore `active` to resume automatic polling.
An app-owned Source is eligible only while its owner in the same Workspace has applied
state and remains enabled. Missing, uninstalled, destroyed, disabled, and never-applied owners are
excluded. Ownerless preflight Sources are collected after 24 hours unless a non-terminal install plan references them.

The dashboard reads that scan result and lets the user select a real module. A matching
entry in `.well-known/takosumi.json` may add input presentation hints and requests for
generic Host APIs or services, but it is not authority for the module path, providers,
Connections, Plans, or Runs.

## Capsule

A Capsule is one deployed unit. Where a Source says where the code comes from, a Capsule
says what is running right now.

Each new app owns a separate Source, including apps added from the same repository.
Existing shared Sources must be split with the operator migration. Modules carry no credentials and no notion of
environment, so development and production use separate Capsules with their own Sources
and Connections (see [Credentials](./credentials.md)).

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/capsules" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

When a new commit arrives on the Source a Capsule tracks, the Capsule becomes `stale`.
**`stale` is a state, not an action.** The default is to stop there; a person starts the
next plan and apply.

Only a Capsule with `autoUpdate` explicitly enabled creates one update plan for each new
snapshot. Only a plan with no deletion or replacement, no approval or policy gate, and a
known list of resource changes continues to apply on its own. Any other plan stops on the
Run page. A `stale` marker, drift detection, or a repeat notification for an old snapshot
never starts an apply unconditionally.

## The screen, and links from outside

The standard entrance is `/new` in the dashboard. Give it a Git URL and it discovers
real modules from the scan, then shows the variables and providers they need. A ref may
be supplied when needed.

Connection requirements appear on screen. Since a provider source alone may not
distinguish them, check the module name and alias shown for each requirement and select a
Connection for each one. Providers that do not require credentials need no Connection.

There is a link form for sending users into that screen from another application.

```text
https://takosumi.example.com/install?git=https://github.com/example/app.git&ref=v1.2.0&sourcePath=infra&path=deploy/opentofu
```

`sourcePath` is the Git subtree captured, archived, and scanned; it defaults to `.`.
`path` is the folder of the module to add, relative to `sourcePath`. It is checked against
the resulting Snapshot scan and ignored if the scan does not find it. Takosumi does not join or guess between these coordinates: one scopes
Source acquisition and the other selects a module. With no `path`, exactly one candidate
is auto-selected and multiple candidates require a user choice. `/install` only fills in
the fields of `/new`. **Opening the link creates nothing.** The
user sees the compatibility result, the credentials that would be used, and the plan
before approving anything.

How to build a link for a README or website is in
[Share an install link](../getting-started/install-link.md), and the rules for the return URI
are in [App Handoff](../reference/app-handoff.md). Query strings end up in browser history and
in logs, so keep secrets out of the link.

## Related

- [Run model](./run-model.md)
- [Credentials](./credentials.md)
- [API reference](../reference/api.md)
