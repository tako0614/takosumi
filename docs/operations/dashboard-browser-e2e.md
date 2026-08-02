# Dashboard browser E2E

Takosumi's portable gate runs a real Chrome browser against the built dashboard
and a same-origin, authenticated mock API. It does not deploy, use a provider,
or require credentials. The fixture covers dashboard bootstrap, Workspace
switching, `/new`, repository-owned launcher URLs, and ObjectBucket customer-key
controls.

`bun run check` invokes this gate through `check:dashboard-browser` after the
dashboard build. The fixture deliberately fails on missing build output,
missing auth cookie, unknown API routes, and browser runtime errors; it is not a
network-skipped test. The root Bun unit-test command excludes this directory so
the Playwright runner remains the only owner of these browser tests.

Traffic monitoring is fail-closed: portable mode rejects same-origin API,
capability, and asset 4xx/5xx responses plus HTTP request failures. Live mode
rejects HTTP 5xx and request failures, and treats bootstrap, Workspace/app,
Resource, and S3 customer-key route 4xx responses as failures. Optional live
probes such as capability and form-availability discovery may return 4xx while
the required surfaces remain healthy.

Live storage state must be an existing regular JSON file outside the repository
worktree. Repository-local paths and symlinked paths are rejected before
Playwright starts; keep the file in external operator state and never commit
it.

Live evidence is a separate, operator-supplied run:

```bash
TAKOSUMI_E2E_BASE_URL=https://dashboard.example.test \
TAKOSUMI_E2E_STORAGE_STATE=/outside-repo/takosumi-session.json \
TAKOSUMI_E2E_WORKSPACE_NAME="Production" \
TAKOSUMI_E2E_SWITCH_WORKSPACE_NAME="Staging" \
TAKOSUMI_E2E_APP_NAME="Repository-owned app" \
TAKOSUMI_E2E_APP_URL="https://app.example.test/" \
TAKOSUMI_E2E_OBJECT_BUCKET_NAME="assets" \
bun run dashboard:e2e:live
```

The storage-state JSON is external and must contain the authenticated browser
session for the supplied base URL. Do not commit it or pass credentials in the
URL. Live mode fails closed when any listed input is missing or the state file
does not exist. Set `TAKOSUMI_E2E_BROWSER_CHANNEL` only when the installed
Playwright-compatible browser is not the default system Chrome.
