import platformWorker, { type CloudflareWorkerEnv } from "../../../../deploy/platform/worker.ts";

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv) {
    // Only the Node-side Miniflare driver uses this test header. Reconstruct
    // Origin inside workerd because its Node RPC proxy rejects remote Origin.
    const originalOrigin = request.headers.get("x-fixture-original-origin");
    if (originalOrigin !== null) {
      const headers = new Headers(request.headers);
      headers.delete("x-fixture-original-origin");
      headers.set("origin", originalOrigin);
      request = new Request(request, { headers });
    }
    // The oversized-body case enters through fresh real local HTTP, isolated
    // from the mixed Node RPC driver's reset. Translate only that fixture
    // loopback URL to the configured test origin; retain its real body.
    const url = new URL(request.url);
    const localHTTP = url.hostname === "127.0.0.1";
    const length = request.headers.get("content-length");
    const transfer = request.headers.get("transfer-encoding");
    if (localHTTP) {
      request = new Request(new URL(url.pathname + url.search, env.TAKOSUMI_SHARED_AUTH_ORIGIN), request);
    }
    const response = await platformWorker.fetch(request, env);
    if (localHTTP) {
      const headers = new Headers(response.headers);
      headers.set("x-fixture-incoming-content-length", String(length));
      headers.set("x-fixture-incoming-transfer-encoding", String(transfer));
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
