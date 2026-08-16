import { afterEach, describe, expect, test } from "bun:test";
import { getInstallConfig } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("InstallConfig cancellation", () => {
  test("aborts a never-settling config GET when its signal is cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!receivedSignal) {
          reject(new Error("InstallConfig GET omitted its AbortSignal"));
          return;
        }
        receivedSignal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = getInstallConfig("cfg_1", {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(receivedSignal).toBe(controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("keeps the existing no-options caller contract", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === "string" ? input : String(input);
      return new Response(
        JSON.stringify({
          installConfig: {
            id: "cfg_1",
            name: "Worker",
            sourceKind: "first_party_capsule",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(getInstallConfig("cfg_1")).resolves.toMatchObject({
      id: "cfg_1",
    });
    expect(requestedUrl).toBe("/api/v1/capsule-configs/cfg_1");
  });
});
