import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  readBoundedResponseBytes,
  RunnerArtifactSizeLimitError,
} from "../../../worker/src/durable/OpenTofuRunnerObject.ts";

function chunkedResponse(
  chunks: readonly Uint8Array[],
  headers?: HeadersInit,
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (!chunk) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    }),
    { headers },
  );
}

test("bounded artifact reader accepts one byte under the limit without Content-Length", async () => {
  const maxBytes = 8;
  const expected = new Uint8Array(maxBytes - 1).fill(0x61);
  const response = chunkedResponse([expected.slice(0, 3), expected.slice(3)]);

  assert.deepEqual(
    await readBoundedResponseBytes(response, "state", maxBytes),
    expected,
  );
});

test("bounded artifact reader rejects one byte over with absent Content-Length", async () => {
  const maxBytes = 8;
  const response = chunkedResponse([
    new Uint8Array(4),
    new Uint8Array(maxBytes - 3),
  ]);

  await assert.rejects(
    () => readBoundedResponseBytes(response, "plan", maxBytes),
    (error: unknown) => {
      assert.ok(error instanceof RunnerArtifactSizeLimitError);
      assert.equal(error.artifact, "plan");
      assert.equal(error.maxBytes, maxBytes);
      assert.equal(error.observedBytes, maxBytes + 1);
      return true;
    },
  );
});

test("bounded artifact reader rejects oversized Content-Length before pulling the body", async () => {
  const maxBytes = 8;
  let pulls = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([0x61]));
        controller.close();
      },
    }),
    { headers: { "content-length": String(maxBytes + 1) } },
  );

  await assert.rejects(
    () => readBoundedResponseBytes(response, "source_archive", maxBytes),
    RunnerArtifactSizeLimitError,
  );
  assert.equal(pulls, 0);
});

test("bounded artifact reader ignores a forged small Content-Length and catches chunked overflow", async () => {
  const maxBytes = 8;
  const response = chunkedResponse(
    [new Uint8Array(5), new Uint8Array(4)],
    { "content-length": "1" },
  );

  await assert.rejects(
    () => readBoundedResponseBytes(response, "output", maxBytes),
    (error: unknown) => {
      assert.ok(error instanceof RunnerArtifactSizeLimitError);
      assert.equal(error.observedBytes, maxBytes + 1);
      return true;
    },
  );
});
