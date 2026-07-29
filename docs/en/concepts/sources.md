# Sources and Capsules

Git is the single source of truth for Takosumi. Whatever is running corresponds to some
commit in some repository.

## Source

A Source declares that you want to follow this directory of this repository at this ref.

Only three things are required: the Workspace, a name, and a URL.

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
| `defaultPath`      | `.`          | The module directory inside the repository               |
| `authConnectionId` | none         | The Connection used to read a private repository         |
| `autoSync`         | `false`      | The operator's scheduler checks the Git ref periodically |

The creation response carries a `hookSecret`. **It is returned in the clear exactly once,
at creation, and cannot be retrieved afterwards.** The Source record stores only a hash.
If you are going to configure a webhook on your Git host, copy it now. If you lose it, you
create a new one rather than fetching it again.

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

Wait until the sync Run reaches `succeeded` and that Run's `sourceSnapshotId` appears
under `/api/v1/sources/{sourceId}/snapshots`, then move on to the compatibility check and
the plan. **Do not reuse an older snapshot as if it were the latest one.** What you
reviewed and what you apply would stop matching.

## Capsule

A Capsule is one deployed unit. Where a Source says where the code comes from, a Capsule
says what is running right now.

One Source can back several Capsules. Modules carry no credentials and no notion of
environment, so development and production are expressed by giving separate Capsules
separate Connections (see [Credentials](./credentials.md)).

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/workspaces/ws_example/capsules" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

When a new commit arrives on the Source a Capsule tracks, the Capsule becomes `stale`.
**`stale` is a state, not an action.** The default is to stop there; a person starts the
next plan and apply.

Only a Capsule with `autoUpdate` explicitly enabled creates one update plan for each new
snapshot. A clean plan can continue to apply when it has no deletion, approval, or policy
gate. Any gated plan stops on the Run page. A `stale` marker, drift detection, or a repeat
notification for an old snapshot never starts an apply unconditionally.

## The screen, and links from outside

The standard entrance is `/new` in the dashboard. Give it a Git URL and it reads the
module, then shows the variables and providers it needs.

There is a link form for sending users into that screen from another application.

```text
https://takosumi.example.com/install?git=https://github.com/example/app.git&ref=v1.2.0&path=deploy/opentofu
```

`/install` only fills in the fields of `/new`. **Opening the link creates nothing.** The
user sees the compatibility result, the credentials that would be used, and the plan
before approving anything.

The details of assembling one of these links, including the rules for the return URI, are
in [App Handoff](../reference/app-handoff.md). Query strings end up in browser history and
in logs, so keep secrets out of the link.

## Related

- [Run model](./run-model.md)
- [Credentials](./credentials.md)
- [API reference](../reference/api.md)
