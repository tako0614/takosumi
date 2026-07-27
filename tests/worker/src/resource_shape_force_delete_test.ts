import { describe, expect, test } from "bun:test";

import { operatorResourceShapeForceDeleteAuthorized } from "../../../worker/src/worker_service.ts";

const operatorActor = {
  actorAccountId: "platform-resource-shape",
  roles: ["owner"] as const,
  requestId: "request_operator",
};

describe("operator Resource force delete authorization", () => {
  test("accepts only the direct deploy-control bearer", () => {
    expect(
      operatorResourceShapeForceDeleteAuthorized(
        { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" },
        {
          actor: operatorActor,
          request: new Request("https://app.takosumi.test/v1/resources/x/y", {
            headers: { authorization: "Bearer operator-secret" },
          }),
        },
      ),
    ).toBe(true);

    expect(
      operatorResourceShapeForceDeleteAuthorized(
        { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" },
        {
          actor: operatorActor,
          request: new Request("https://app.takosumi.test/v1/resources/x/y", {
            headers: { authorization: "Bearer wrong" },
          }),
        },
      ),
    ).toBe(false);
  });

  test("rejects delegated account and service actors after bearer rewriting", () => {
    for (const actor of [
      {
        actorAccountId: "account_1",
        roles: ["owner"] as const,
        requestId: "request_account",
        principalKind: "account" as const,
      },
      {
        actorAccountId: "release-service",
        roles: ["owner"] as const,
        requestId: "request_service",
        principalKind: "service" as const,
        serviceId: "release-service",
      },
    ]) {
      expect(
        operatorResourceShapeForceDeleteAuthorized(
          { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" },
          {
            actor,
            request: new Request(
              "https://app.takosumi.test/v1/resources/x/y",
              { headers: { authorization: "Bearer operator-secret" } },
            ),
          },
        ),
      ).toBe(false);
    }
  });

  test("fails closed when the operator token is absent", () => {
    expect(
      operatorResourceShapeForceDeleteAuthorized(
        {},
        {
          actor: operatorActor,
          request: new Request("https://app.takosumi.test/v1/resources/x/y"),
        },
      ),
    ).toBe(false);
  });
});
