# Dashboard browser E2E

Takosumi's portable gate runs a real Chrome browser against the built dashboard
and a same-origin, authenticated mock API. It does not deploy, use a provider,
or require credentials. The fixture covers dashboard bootstrap, Workspace
switching, `/new`, repository-owned launcher URLs, and ObjectBucket customer-key
controls.

The `public-live` profile is a separate unauthenticated, read-only release
probe. It needs only the official dashboard base URL and the exact lowercase
Worker Version UUID; it never reads storage state and does not accept Workspace,
app, provider, or other fixture inputs. It probes OIDC discovery, JWKS, the
unauthenticated dashboard bootstrap (`401`), direct/deep SPA documents, and the
signed-out `/install?...` return-link semantics. It records a zero-mutation
control-plane/provider fence and fails closed on redirects, non-success status,
non-HTML/JSON content types, request failures, or any missing/substituted
`x-takosumi-version-id` on an official-origin response.

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

Public-live treats every same-origin 4xx/5xx and every HTTP request failure as
fatal; external-origin telemetry is outside its mutation fence.

Live mode also requires the operator-supplied immutable Worker Version identity
on every top-level same-origin document and required API/probe response. This
includes the dashboard bootstrap and Workspace routes, OIDC discovery,
`/oauth/jwks`, and the unauthenticated API-gate probe. Static assets and other
subresources are not used as Version evidence. Missing or substituted
`x-takosumi-version-id` headers fail the run. The runner emits no
process-global success report; the Playwright exit status and retained failure
artifacts are the evidence.

The live journey opens the existing launcher/Workspace shell, `/new`, direct
SPA deep links, and `/install?git=...&ref=...&path=...` and checks that the
install link only pre-fills the form. It records any control-plane mutation
request and fails if navigation or discovery creates a Source, Run, Capsule,
ProviderConnection, or other control-plane object.

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
TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID="00000000-0000-4000-8000-000000000001" \
bun run dashboard:e2e:live
```

The storage-state JSON is external and must contain the authenticated browser
session for the supplied base URL. Do not commit it or pass credentials in the
URL. Live mode fails closed when any listed input is missing or the state file
does not exist. Set `TAKOSUMI_E2E_BROWSER_CHANNEL` only when the installed
Playwright-compatible browser is not the default system Chrome.

The public-live evidence run has no storage-state argument:

```bash
TAKOSUMI_E2E_BASE_URL=https://app.takosumi.com \
TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID="00000000-0000-4000-8000-000000000001" \
bun run dashboard:e2e:public-live
```

The same two values may be supplied explicitly for operator tooling as
`--base-url <http(s)-url>` and `--worker-version-id <lowercase-uuid>` (or
`--expected-worker-version-id`) after the `public-live` runner name.

The live runner deliberately does not automate sign-in, mint a session, or
fake an OAuth callback. The authenticated checks start from the supplied
operator storage state; OIDC discovery/JWKS and the unauthenticated API gate
are probed separately without that state. If the real callback cannot be
replayed from the operator-owned session, record that as an explicit live
evidence gap rather than weakening the browser assertions.
