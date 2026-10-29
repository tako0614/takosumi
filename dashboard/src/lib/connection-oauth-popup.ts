import {
  listProviderConnections,
  startConnectionOAuth,
  type ConnectionOAuthSetup,
  type ProviderConnection,
} from "./control-api.ts";

/** The install form stays mounted; credentials and draft values never enter storage. */
export async function connectProviderWithPopup(input: {
  readonly helper: ConnectionOAuthSetup;
  readonly workspaceId?: string;
  readonly displayName?: string;
  readonly scopeHints?: import("./control-api.ts").ConnectionScopeHints;
  readonly signal: AbortSignal;
  readonly popup: Window;
}): Promise<ProviderConnection> {
  const before = new Set((await listProviderConnections(input.workspaceId)).map((row) => row.id));
  input.signal.throwIfAborted();
  const started = await startConnectionOAuth({ ...input, helperId: input.helper.id });
  input.signal.throwIfAborted();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(started.state))));
  const flow = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const channel = new BroadcastChannel(`takosumi.oauth.${flow}`);
  let failed = false;
  let completedId: string | undefined;
  let completedStatus: string | undefined;
  channel.onmessage = (event) => {
    if (event.data?.kind === "connection-oauth" && event.data.error === true) failed = true;
    if (event.data?.kind === "connection-oauth" && event.data.error === false && typeof event.data.connectionId === "string") {
      completedId = event.data.connectionId; completedStatus = event.data.connectionStatus;
    }
  };
  const authorization = new URL(started.authorizationUrl);
  if (authorization.protocol !== "https:") throw new Error("Invalid authorization URL");
  // Do not grant the provider an opener navigation capability. Completion is
  // observed through authenticated reads, including when COOP severs the popup.
  try {
    input.popup.opener = null;
    input.popup.location.replace(authorization.toString());
  const deadline = Math.min(Date.now() + 10 * 60_000,
    started.expiresAt ? Date.parse(started.expiresAt) : Infinity);
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(input.signal.reason); };
      const timer = setTimeout(() => { input.signal.removeEventListener("abort", abort); resolve(); }, 1500);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
    input.signal.throwIfAborted();
    if (failed) throw new Error("Provider authorization was not completed");
    try {
      const location = new URL(input.popup.location.href);
      if (location.origin === window.location.origin && location.pathname === "/connections" && location.searchParams.has("connection_error")) {
        throw new Error("Provider authorization was not completed");
      }
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      // Cross-origin location access is expected during provider consent.
    }
    const connections = await listProviderConnections(input.workspaceId);
    input.signal.throwIfAborted();
    const created = connections.find((row) => row.id === completedId && !before.has(row.id) &&
      row.workspaceId === input.workspaceId &&
      (input.workspaceId ? row.scope === "workspace" : row.scope !== "operator") &&
      row.credentialRecipe?.id === input.helper.credentialRecipe.id &&
      row.credentialRecipe.authMode === input.helper.credentialRecipe.authMode &&
      (row.status === "verified" || (row.status === "pending" && completedStatus === "pending")));
    if (created) return created;
  }
  throw new Error("Provider authorization timed out");
  } finally { channel.close(); }
}
