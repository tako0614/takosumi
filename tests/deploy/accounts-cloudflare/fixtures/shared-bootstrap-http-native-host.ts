import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";

const input = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const { Miniflare } = await import(input.miniflareModuleUrl) as typeof import("miniflare");
const issuer = input.issuer as string;
const fixtureSubject = "tsub_bootstrap_native_fixture";
const bindings = input.bindings as Record<string, unknown>;
const disconnect = input.mode === "disconnect";
let gateResponse: ServerResponse | undefined;
let gatePeerClosedBeforeRelease = false;

const gateServer = disconnect ? createServer((_request, response) => {
  gateResponse = response;
  response.on("close", () => { if (!response.writableEnded) gatePeerClosedBeforeRelease = true; });
}) : undefined;
if (gateServer) {
  await new Promise<void>((resolve) => gateServer.listen(0,"127.0.0.1",resolve));
  const address = gateServer.address();
  assert.ok(address && typeof address !== "string");
  bindings.FIXTURE_GATE_URL = `http://127.0.0.1:${address.port}/original-control-flight`;
}
const runtime = new Miniflare({
  script: input.workerSource,
  // Miniflare upstream normalizes the loopback Host to this synthetic issuer;
  // the unchanged production origin/Host guard still receives a coherent pair.
  upstream: issuer,
  modules: true,
  compatibilityDate: input.compatibilityDate,
  compatibilityFlags: ["nodejs_compat"],
  bindings,
  d1Databases: ["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"],
});
async function safeJson(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { return null; } }
async function durableState() {
  const db = await runtime.getD1Database("TAKOSUMI_CONTROL_DB");
  const controlHead = await db.prepare("SELECT max(version) AS head FROM schema_migrations").first<{ head: number | null }>();
  const accountsDb = await runtime.getD1Database("TAKOSUMI_ACCOUNTS_DB");
  const accountsHead = await accountsDb.prepare("SELECT max(version) AS head FROM takosumi_accounts_schema_migrations").first<{ head: number | null }>();
  const workspaces = await db.prepare("SELECT id, record_json FROM workspaces WHERE personal_bootstrap_owner_id = ?").bind(fixtureSubject).all<{ id: string; record_json: string }>();
  const members = await db.prepare("SELECT record_json FROM workspace_members WHERE account_id = ? AND status = 'active'").bind(fixtureSubject).all<{ record_json: string }>();
  const records = (members.results ?? []).map((row) => { try { return JSON.parse(row.record_json) as { workspaceId?: string; roles?: string[]; status?: string }; } catch { return {}; } });
  const workspaceIds = new Set((workspaces.results ?? []).map((row) => row.id));
  const currentOwnerMembers = records.filter((row) => !!row.workspaceId && workspaceIds.has(row.workspaceId) && row.status === "active" && row.roles?.includes("owner")).length;
  return { controlSchemaHead: controlHead?.head ?? null, accountsSchemaHead: accountsHead?.head ?? null, personalWorkspaceRows: workspaces.results?.length ?? null, activeOwnerMemberRows: currentOwnerMembers };
}
let report: Record<string, unknown> = { schema: "accounts.bootstrap.native.fixture.v1", localSyntheticD1: true, authorityOrStagingQualification: false, tokenOrCookieValuesLogged: false };
try {
  const prepared = await runtime.dispatchFetch(`${issuer}/__fixture/prepare`, { method: "POST", headers: { host: new URL(issuer).host, "MF-Original-URL": `${issuer}/__fixture/prepare` } });
  const prepareJson = await safeJson(prepared);
  assert.equal(prepared.status, 200);
  assert.equal(prepareJson?.ok, true);
  const cookie = prepareJson?.cookie;
  assert.equal(typeof cookie, "string");
  // Exercise the same registered-client Bearer branch as the RP: synthetic
  // issuer session -> real consent/code exchange -> persisted current grant.
  // Redirects stay manual and no external issuer/provider request is made.
  const clients = JSON.parse(String(bindings.TAKOSUMI_ACCOUNTS_CLIENTS)) as {clientId:string;redirectUris:string[];clientSecretEnv:string}[];
  const client = clients.find((item) => item.clientId === "takoserver-console-staging-v1")!;
  const redirectUri = client.redirectUris[1]!;
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))).toString("base64url");
  const authorizeUrl = new URL(`${issuer}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({response_type:"code",client_id:client.clientId,redirect_uri:redirectUri,scope:"openid email offline_access",nonce:"fixture-nonce",state:"fixture-state",code_challenge:challenge,code_challenge_method:"S256"}).toString();
  const consent = await runtime.dispatchFetch(authorizeUrl,{headers:{cookie:String(cookie)},redirect:"manual"});
  assert.equal(consent.status,200,"local registered-client consent");
  const transaction = (await consent.text()).match(/name="consent_transaction" value="([^"]+)"/u)?.[1];
  assert.equal(typeof transaction,"string");
  const authorized = await runtime.dispatchFetch(authorizeUrl,{method:"POST",headers:{cookie:String(cookie),origin:issuer,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({approve:"yes",consent_transaction:transaction!}).toString(),redirect:"manual"});
  assert.equal(authorized.status,302,"local original authorization code");
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  await authorized.arrayBuffer();
  const exchanged = await runtime.dispatchFetch(`${issuer}/oauth/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",authorization:`Basic ${Buffer.from(`${client.clientId}:${bindings[client.clientSecretEnv]}`).toString("base64")}`},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri,code_verifier:verifier}).toString(),redirect:"manual"});
  assert.equal(exchanged.status,200,"local original code exchange");
  const grant = await exchanged.json() as {access_token:string};
  assert.equal(typeof grant.access_token,"string");

  const reset = await runtime.dispatchFetch(`${issuer}/__fixture/reset`, { method: "POST", headers: { host: new URL(issuer).host, "MF-Original-URL": `${issuer}/__fixture/reset` } });
  assert.equal(reset.status, 200);
  const controller = new AbortController();
  const started = performance.now();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  let responseStatus: number | null = null;
  let bodySummary: Record<string, unknown> | null = null;
  let callerOutcome = "status_observed";
  try {
    const response = await runtime.dispatchFetch(`${issuer}/api/v1/account/shared-workspaces/bootstrap`, {
      method: "POST",
      headers: { host: new URL(issuer).host, authorization: `Bearer ${grant.access_token}`, "content-type": "application/json", "MF-Original-URL": `${issuer}/api/v1/account/shared-workspaces/bootstrap` },
      body: "{}",
      signal: controller.signal,
    });
    responseStatus = response.status;
    const body = await safeJson(response);
    const workspace = body && typeof body.workspace === "object" && body.workspace !== null ? body.workspace as Record<string, unknown> : null;
    bodySummary = workspace ? {
      workspacePresent: true,
      personalType: workspace.type === "personal",
      ownerMatchesSyntheticAccount: workspace.ownerUserId === fixtureSubject,
      idPresent: typeof workspace.id === "string" && workspace.id.length > 0,
    } : { workspacePresent: false };
  } catch {
    callerOutcome = controller.signal.aborted ? "five_second_client_abort_without_status" : "dispatch_rejected_without_status";
  } finally { clearTimeout(deadline); }
  const callerDurationMs = performance.now() - started;
  let readOnlyFollowupStatus: number | null = null;
  let readOnlyFollowupOutcome = "not_requested";
  if (disconnect) {
    // The POST is never replayed. Release only the original pending I/O and
    // inspect a fresh read-only menu request against the same Worker/env.
    assert.equal(callerOutcome,"five_second_client_abort_without_status");
    assert.ok(gateResponse,"the cold initializer must reach the native I/O barrier");
    gateResponse!.writeHead(204); gateResponse!.end();
    const readAbort = new AbortController();
    const readDeadline = setTimeout(() => readAbort.abort(),5_000);
    try {
      const response = await runtime.dispatchFetch(`${issuer}/api/v1/account/shared-workspaces`,{headers:{authorization:`Bearer ${grant.access_token}`},signal:readAbort.signal});
      readOnlyFollowupStatus = response.status;
      await response.arrayBuffer();
      readOnlyFollowupOutcome = "status_observed";
    } catch { readOnlyFollowupOutcome = readAbort.signal.aborted ? "five_second_read_deadline" : "read_transport_rejected"; }
    finally { clearTimeout(readDeadline); }
  }
  let diagnostics: Record<string, unknown> | null = null;
  try { diagnostics = await safeJson(await runtime.dispatchFetch(`${issuer}/__fixture/diagnostics`, { headers: { host: new URL(issuer).host, "MF-Original-URL": `${issuer}/__fixture/diagnostics` } })); } catch { /* preserve unavailable marker */ }
  const requestState = diagnostics?.lastRequest && typeof diagnostics.lastRequest === "object" ? diagnostics.lastRequest as Record<string, unknown> : null;
  const completed = requestState?.completedAt !== null && requestState?.completedAt !== undefined;
  const durable = completed || disconnect ? await durableState() : null;
  report = {
    ...report,
    authInputClass: "synthetic_real_oidc_code_exchange_bearer",
    exactR9SharedGrantBearerPathReproduced: false,
    callerOutcome,
    disconnect, gatePeerClosedBeforeRelease, readOnlyFollowupStatus, readOnlyFollowupOutcome,
    gateEntered: diagnostics?.gateEntered === true, gateFinished: diagnostics?.gateFinished === true,
    callerDurationMs,
    responseStatus,
    bodySummary,
    requestCompleted: completed,
    inFlightAfterClientResult: diagnostics?.inFlight === true,
    requestMarkers: requestState,
    durableTerminal: durable,
    terminalOracleQualified: completed && durable !== null,
  };
  console.log(JSON.stringify(report));
  if (disconnect) {
    assert.equal(readOnlyFollowupOutcome,"status_observed","original initializer must settle after client disconnect without replaying POST");
    assert.equal(readOnlyFollowupStatus,200);
    assert.equal(diagnostics?.gateFinished,true);
    assert.equal(completed,true);
    assert.equal(durable?.personalWorkspaceRows,1);
    assert.equal(durable?.activeOwnerMemberRows,1);
  } else {
  assert.equal(callerOutcome, "status_observed", "native bootstrap caller deadline expired; finite request markers are emitted above");
  assert.equal(responseStatus, 200);
  assert.ok(Number(callerDurationMs) < 5_000);
  assert.equal(bodySummary?.workspacePresent, true);
  assert.equal(bodySummary?.personalType, true);
  assert.equal(bodySummary?.ownerMatchesSyntheticAccount, true);
  assert.equal(completed, true);
  assert.equal((durable as { personalWorkspaceRows?: number } | null)?.personalWorkspaceRows, 1);
  assert.equal((durable as { activeOwnerMemberRows?: number } | null)?.activeOwnerMemberRows, 1);
  }
} catch (error) {
  // Keep diagnostics bounded and avoid printing raw request, cookie, SQL or D1 rows.
  if (!Object.hasOwn(report, "callerOutcome")) console.log(JSON.stringify({ ...report, fixtureFailureClass: "preflight_or_harness_failure" }));
  process.exitCode = 1;
} finally {
  try { await runtime.dispose(); }
  finally {
    if (gateServer) {
      gateServer.closeAllConnections();
      await new Promise<void>((resolve,reject) => gateServer.close((error) => error ? reject(error) : resolve()));
    }
  }
}
