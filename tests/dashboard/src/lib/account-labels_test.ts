import { describe, expect, test } from "bun:test";
import {
  activityActorLabel,
  sessionDisplayName,
  shortSubject,
} from "../../../../dashboard/src/lib/account-labels.ts";
import { activityServiceName } from "../../../../dashboard/src/lib/activity-copy.ts";
import type { ActivityEvent } from "../../../../dashboard/src/lib/control-api.ts";
import { t } from "../../../../dashboard/src/i18n/index.ts";

const session = {
  subject: "tsub_0123456789abcdef",
  displayName: "  Hana  ",
  email: "hana@example.test",
};

describe("account labels", () => {
  test("your own events read as you, the control plane as automatic", () => {
    expect(activityActorLabel(session.subject, session)).toBe(
      t("activity.actorYou"),
    );
    expect(activityActorLabel("system", session)).toBe(
      t("activity.actorSystem"),
    );
  });

  test("other people keep the same short subject the member list shows", () => {
    expect(activityActorLabel("tsub_fedcba9876543210", session)).toBe(
      shortSubject("tsub_fedcba9876543210"),
    );
    expect(shortSubject("tsub_fedcba9876543210")).toBe("tsub_fedcb…");
  });

  test("the session name prefers display name, then email", () => {
    expect(sessionDisplayName(session)).toBe("Hana");
    expect(sessionDisplayName({ ...session, displayName: " " })).toBe(
      "hana@example.test",
    );
    expect(
      sessionDisplayName({ subject: session.subject }),
    ).toBeUndefined();
  });
});

describe("activityServiceName", () => {
  const event = (
    metadata: Record<string, unknown>,
    target: Partial<ActivityEvent> = {},
  ): ActivityEvent =>
    ({
      id: "act_1",
      workspaceId: "ws_1",
      action: "run.applied",
      targetType: "run",
      targetId: "run_1",
      createdAt: "2026-10-13T00:00:00.000Z",
      metadata,
      ...target,
    }) as ActivityEvent;
  const names = new Map([["cap_1", "blog"]]);

  test("prefers the name the backend recorded", () => {
    expect(
      activityServiceName(event({ capsuleName: "shop", capsuleId: "cap_1" }), names),
    ).toBe("shop");
  });

  test("resolves the recorded service id, also when it is the target", () => {
    expect(activityServiceName(event({ capsuleId: "cap_1" }), names)).toBe(
      "blog",
    );
    expect(
      activityServiceName(
        event({}, { targetType: "capsule", targetId: "cap_1" }),
        names,
      ),
    ).toBe("blog");
  });

  test("leaves unknown services unnamed instead of showing the id", () => {
    expect(activityServiceName(event({ capsuleId: "cap_gone" }), names)).toBe(
      undefined,
    );
  });
});
