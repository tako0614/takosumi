import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  isInterfaceMaterializationRetryStale,
  retryInterfaceMaterializationFailure,
  type CapsuleInterfaceMaterializationFailure,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FAILURE: CapsuleInterfaceMaterializationFailure = {
  id: "cimi_failure",
  capsuleId: "capsule_failure",
  stateVersionId: "state_failure",
  outputId: "output_failure",
  stateGeneration: 3,
  blueprintsDigest: `sha256:${"2".repeat(64)}`,
  totalItems: 4,
  nextItemIndex: 2,
  attempts: 1,
  error: {
    code: "interface_provenance_conflict",
    detailDigest: `sha256:${"3".repeat(64)}`,
    recordedAt: "2026-08-29T12:00:00.000Z",
  },
  deadLetteredAt: "2026-08-29T12:00:00.000Z",
  failureDigest: `sha256:${"1".repeat(64)}`,
};

describe("Interface materialization failure control client", () => {

  test("POSTs exactly the observed failure/state identity", async () => {
    let captured: { readonly url: string; readonly init?: RequestInit };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = {
        url: typeof input === "string" ? input : String(input),
        ...(init ? { init } : {}),
      };
      return new Response(
        JSON.stringify({
          retry: {
            id: FAILURE.id,
            capsuleId: FAILURE.capsuleId,
            stateVersionId: FAILURE.stateVersionId,
            stateGeneration: FAILURE.stateGeneration,
            blueprintsDigest: FAILURE.blueprintsDigest,
            status: "pending",
            nextItemIndex: FAILURE.nextItemIndex,
            totalItems: FAILURE.totalItems,
            nextRetryAt: "2026-08-29T12:01:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const receipt = await retryInterfaceMaterializationFailure(
      "workspace 1",
      "intent 1",
      {
        failureDigest: FAILURE.failureDigest,
        stateVersionId: FAILURE.stateVersionId,
        stateGeneration: FAILURE.stateGeneration,
      },
    );

    expect(receipt.status).toBe("pending");
    expect(captured!.url).toBe(
      "/api/v1/workspaces/workspace%201/interface-materialization-failures/intent%201/retries",
    );
    expect(captured!.init?.method).toBe("POST");
    expect(JSON.parse(String(captured!.init?.body))).toEqual({
      failureDigest: FAILURE.failureDigest,
      stateVersionId: FAILURE.stateVersionId,
      stateGeneration: FAILURE.stateGeneration,
    });
  });

  test("classifies disappeared and changed rows as stale without classifying 403", () => {
    expect(
      isInterfaceMaterializationRetryStale(
        new ControlApiError(404, "not_found", "missing"),
      ),
    ).toBe(true);
    expect(
      isInterfaceMaterializationRetryStale(
        new ControlApiError(409, "failed_precondition", "changed"),
      ),
    ).toBe(true);
    expect(
      isInterfaceMaterializationRetryStale(
        new ControlApiError(403, "forbidden", "forbidden"),
      ),
    ).toBe(false);
  });
});
