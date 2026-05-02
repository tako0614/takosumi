import assert from "node:assert/strict";
import {
  AwsHttpGatewayClient,
  type AwsObjectStorageClient,
  createAwsHttpGatewayHandler,
} from "../src/providers/aws/mod.ts";
import {
  createGcpHttpGatewayHandler,
  GcpHttpGatewayClient,
  type GcpKmsClient,
} from "../src/providers/gcp/mod.ts";

Deno.test("AWS HTTP gateway client posts JSON with auth headers", async () => {
  const requests: CapturedRequest[] = [];
  const objectHead = {
    bucket: "artifacts",
    key: "a.txt",
    contentLength: 3,
    metadata: {},
    digest: "sha256:abc" as const,
    etag: "etag",
    updatedAt: "2026-04-29T00:00:00.000Z",
  };
  const client: AwsObjectStorageClient = new AwsHttpGatewayClient({
    baseUrl: "https://gateway.example.test/aws-root",
    bearerToken: "token-1",
    headers: { "x-operator": "takos" },
    fetch: captureFetch(
      requests,
      () =>
        new Response(JSON.stringify({ result: objectHead }), { status: 200 }),
    ),
  });

  const result = await client.putObject({
    bucketName: "artifacts",
    objectKey: "a.txt",
    body: new Uint8Array([1, 2, 3]),
  });

  assert.deepEqual(result, objectHead);
  assert.equal(
    requests[0].url,
    "https://gateway.example.test/aws-root/object-storage/put-object",
  );
  assert.equal(requests[0].headers.get("authorization"), "Bearer token-1");
  assert.equal(requests[0].headers.get("x-operator"), "takos");
  assert.deepEqual(requests[0].body, {
    bucketName: "artifacts",
    objectKey: "a.txt",
    body: { $type: "Uint8Array", base64: "AQID" },
  });
});

Deno.test("HTTP gateway clients map null optionals to undefined", async () => {
  const client = new AwsHttpGatewayClient({
    baseUrl: "https://gateway.example.test/aws",
    fetch: captureFetch(
      [],
      () => new Response(JSON.stringify(null), { status: 200 }),
    ),
  });

  assert.equal(
    await client.getObject({ bucketName: "artifacts", objectKey: "missing" }),
    undefined,
  );
});

Deno.test("GCP HTTP gateway client decodes binary JSON responses", async () => {
  const requests: CapturedRequest[] = [];
  const client: GcpKmsClient = new GcpHttpGatewayClient({
    baseUrl: "https://gateway.example.test/gcp/",
    fetch: captureFetch(requests, () =>
      new Response(
        JSON.stringify({ result: { $type: "Uint8Array", base64: "BAU=" } }),
        { status: 200 },
      )),
  });

  const result = await client.decryptEnvelope({
    envelope: {
      version: "takosumi.kms.envelope.v1",
      algorithm: "PROVIDER-KMS",
      keyRef: { provider: "gcp-kms", keyId: "key", keyVersion: "1" },
      iv: "iv",
      ciphertext: "ciphertext",
      createdAt: "2026-04-29T00:00:00.000Z",
    },
  });

  assert.deepEqual([...result], [4, 5]);
  assert.equal(
    requests[0].url,
    "https://gateway.example.test/gcp/kms/decrypt-envelope",
  );
});

Deno.test("HTTP gateway client errors include provider, endpoint, and message", async () => {
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gateway.example.test/gcp",
    fetch: captureFetch(
      [],
      () =>
        new Response(JSON.stringify({ message: "backend unavailable" }), {
          status: 503,
          statusText: "Service Unavailable",
        }),
    ),
  });

  await assert.rejects(
    () => client.listOperations(),
    /gcp gateway provider\/list-operations failed: HTTP 503 Service Unavailable: backend unavailable/,
  );
});

Deno.test("AWS HTTP gateway handler exposes typed service methods", async () => {
  const handler = createAwsHttpGatewayHandler({
    putObject(input) {
      return Promise.resolve({
        bucket: input.bucketName,
        key: input.objectKey,
        contentLength: input.body instanceof Uint8Array
          ? input.body.byteLength
          : `${input.body}`.length,
        metadata: {},
        digest: "sha256:aws" as const,
        etag: "etag",
        updatedAt: "2026-04-29T00:00:00.000Z",
      });
    },
  });
  const client = new AwsHttpGatewayClient({
    baseUrl: "https://gateway.example.test",
    fetch: handlerFetch(handler),
  });

  const result = await client.putObject({
    bucketName: "artifacts",
    objectKey: "bundle.tgz",
    body: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.bucket, "artifacts");
  assert.equal(result.key, "bundle.tgz");
  assert.equal(result.contentLength, 4);
});

Deno.test("GCP HTTP gateway handler returns encoded binary results", async () => {
  const handler = createGcpHttpGatewayHandler({
    decryptEnvelope() {
      return Promise.resolve(new Uint8Array([9, 8, 7]));
    },
  });
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gateway.example.test",
    fetch: handlerFetch(handler),
  });

  const result = await client.decryptEnvelope({
    envelope: {
      version: "takosumi.kms.envelope.v1",
      algorithm: "PROVIDER-KMS",
      keyRef: { provider: "gcp-kms", keyId: "key", keyVersion: "1" },
      iv: "iv",
      ciphertext: "ciphertext",
      createdAt: "2026-04-29T00:00:00.000Z",
    },
  });

  assert.deepEqual([...result], [9, 8, 7]);
});

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function captureFetch(
  requests: CapturedRequest[],
  respond: () => Response,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : `${input}`,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(`${init.body}`) : undefined,
    });
    return Promise.resolve(respond());
  }) as typeof fetch;
}

function handlerFetch(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return handler(new Request(input, init));
  }) as typeof fetch;
}
