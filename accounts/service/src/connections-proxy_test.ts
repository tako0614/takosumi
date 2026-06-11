import { expect, test } from "bun:test";

import {
  forwardCreateConnection,
  forwardListConnections,
  forwardRevokeConnection,
  forwardTestConnection,
  responseFromConnectionsResult,
} from "./connections-proxy.ts";

interface Captured {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | undefined;
}

function recordingFetch(
  respond: () => Response,
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return respond();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const deployControl = (fetchImpl: typeof fetch) => ({
  url: "https://deploy-control.internal/",
  token: "deploy-secret",
  fetch: fetchImpl,
});

test("forwardCreateConnection POSTs the cloudflare/token subroute with the body and bearer", async () => {
  const created = {
    id: "conn_abc",
    spaceId: "space_1",
    provider: "cloudflare",
    owner: "customer",
    authMethod: "static_secret",
    status: "pending",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
  const { fetch: fetchImpl, calls } = recordingFetch(() =>
    Response.json(created, { status: 201 })
  );

  const result = await forwardCreateConnection({
    deployControl: deployControl(fetchImpl),
    body: {
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "super-secret-token-value" },
    },
  });

  expect(result.status).toEqual(201);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toEqual("POST");
  // A provider credential routes to the §30 cloudflare/token subroute.
  expect(calls[0]?.url).toEqual(
    "https://deploy-control.internal/api/connections/cloudflare/token",
  );
  expect(calls[0]?.authorization).toEqual("Bearer deploy-secret");
  expect(calls[0]?.contentType).toEqual("application/json");
  // The write-only values are forwarded to deploy-control verbatim...
  expect(calls[0]?.body).toContain("super-secret-token-value");

  // ...but the upstream response (the public Connection) never echoes them, so
  // the response the proxy returns must not contain the secret value.
  const response = responseFromConnectionsResult(result);
  const text = await response.text();
  expect(text).not.toContain("super-secret-token-value");
  expect(text).toContain("conn_abc");
});

test("forwardCreateConnection routes a source_git_ssh_key body to the ssh-key subroute", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() =>
    Response.json({ id: "conn_ssh" }, { status: 201 })
  );
  await forwardCreateConnection({
    deployControl: deployControl(fetchImpl),
    body: {
      spaceId: "space_1",
      kind: "source_git_ssh_key",
      scopeHints: { knownHostsEntry: "github.com ssh-ed25519 AAAA..." },
      values: { GIT_SSH_PRIVATE_KEY: "k" },
    },
  });
  expect(calls[0]?.url).toEqual(
    "https://deploy-control.internal/api/connections/source/ssh-key",
  );
});

test("forwardListConnections GETs /api/connections?spaceId=...", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() =>
    Response.json({ connections: [] }, { status: 200 })
  );

  const result = await forwardListConnections({
    deployControl: deployControl(fetchImpl),
    spaceId: "space 1/with?chars",
  });

  expect(result.status).toEqual(200);
  expect(calls[0]?.method).toEqual("GET");
  expect(calls[0]?.url).toEqual(
    "https://deploy-control.internal/api/connections?spaceId=space%201%2Fwith%3Fchars",
  );
  expect(calls[0]?.body).toBeUndefined();
});

test("forwardTestConnection POSTs /api/connections/{id}/test", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() =>
    Response.json({ status: "verified" }, { status: 200 })
  );

  const result = await forwardTestConnection({
    deployControl: deployControl(fetchImpl),
    connectionId: "conn_abc",
  });

  expect(result.status).toEqual(200);
  expect(calls[0]?.method).toEqual("POST");
  expect(calls[0]?.url).toEqual(
    "https://deploy-control.internal/api/connections/conn_abc/test",
  );
});

test("forwardRevokeConnection POSTs /api/connections/{id}/revoke and yields a bodyless 204", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() =>
    new Response(null, { status: 204 })
  );

  const result = await forwardRevokeConnection({
    deployControl: deployControl(fetchImpl),
    connectionId: "conn_abc",
  });

  expect(result.status).toEqual(204);
  expect(calls[0]?.method).toEqual("POST");
  expect(calls[0]?.url).toEqual(
    "https://deploy-control.internal/api/connections/conn_abc/revoke",
  );

  const response = responseFromConnectionsResult(result);
  expect(response.status).toEqual(204);
  expect(await response.text()).toEqual("");
});
