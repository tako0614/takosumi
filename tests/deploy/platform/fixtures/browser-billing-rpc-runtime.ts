import { WorkerEntrypoint } from "cloudflare:workers";

const prefix = "__Host-takosumi_hosted_session=";
function syntheticIdentity(request: Request) {
  const cookie = request.headers.get("cookie");
  return cookie === prefix + "native_A" ? "tsub_A" : cookie === prefix + "native_B" ? "tsub_B" :
    cookie === prefix + "revoked_at_receiver" ? "tsub_revoked" : undefined;
}

/** Synthetic authority ONLY: proves actual RPC serialization and OSS routing,
 * not Hosted currentGrant, guarded D1, financial Principal or live admission. */
export class BrowserBillingReceiver extends WorkerEntrypoint {
  fetch() { return new Response(null, { status: 404 }); }
  fetchSharedAuth() { return new Response(null, { status: 404 }); }
  resolveSharedAuthWorkspace() { throw new Error("billing must not select a Workspace"); }
  authenticateSharedAuth(request: Request) {
    if (request.body !== null) throw new Error("gateway authentication consumed a payment body");
    const trace = request.headers.get("x-takosumi-internal-billing-trace");
    if (request.method === "GET" && new URL(request.url).pathname === "/api/v1/billing") {
      if (!/^brpc_[0-9a-f]{32}$/u.test(trace ?? "")) throw new Error("missing internal GET trace");
    } else if (trace !== null) throw new Error("trace escaped the selected GET");
    const accountId = syntheticIdentity(request);
    return accountId ? { kind: "authenticated", accountId } : { kind: "unauthenticated" };
  }
  async fetchWorkspaceDashboard(request: Request, session: { authKind: string; subject: string }) {
    // Independently compare the actual Request's cookie with the assertion.
    const accountId = syntheticIdentity(request);
    if (accountId === "tsub_revoked") return new Response(null, { status: 401 });
    if (!accountId || session.authKind !== "session" || session.subject !== accountId ||
      Object.keys(session).sort().join() !== "authKind,subject") return new Response(null, { status: 503 });
    const headers = Object.fromEntries(request.headers);
    return Response.json({ syntheticTransportProof: true, session, url: request.url,
      method: request.method, cookieSeen: headers.cookie === prefix + (accountId === "tsub_A" ? "native_A" : "native_B"),
      headerNames: Object.keys(headers).sort(), body: await request.text() });
  }
}

export default { fetch() { return new Response(null, { status: 404 }); } };
