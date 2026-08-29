import { describe, expect, test } from "bun:test";
import { capsuleAbandonmentCompleted } from "../../../../dashboard/src/lib/control-api.ts";

describe("Capsule abandonment readback", () => {
  test("accepts the first response and a lost-ack retry only with destroyed readback", () => {
    const expected = { id: "cap_1", workspaceId: "ws_1" };
    const destroyedCapsule = {
      id: "cap_1",
      workspaceId: "ws_1",
      name: "service",
      slug: "service",
      sourceId: "src_1",
      installConfigId: "cfg_1",
      environment: "production",
      currentStateGeneration: 0,
      status: "destroyed",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:01:00.000Z",
    };
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: destroyedCapsule,
        },
        expected,
      ),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted(
        {
          alreadyDeleted: true,
          capsule: destroyedCapsule,
        },
        expected,
      ),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted(
        {
          alreadyDeleted: true,
          capsule: { ...destroyedCapsule, status: "active" },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: { ...destroyedCapsule, id: "cap_other" },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        {
          abandoned: true,
          capsule: { ...destroyedCapsule, currentStateGeneration: 1 },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      capsuleAbandonmentCompleted(
        { abandoned: true, capsule: { status: "destroyed" } },
        expected,
      ),
    ).toBe(false);
    expect(capsuleAbandonmentCompleted({ abandoned: true }, expected)).toBe(
      false,
    );
    expect(capsuleAbandonmentCompleted(null, expected)).toBe(false);
  });
});
