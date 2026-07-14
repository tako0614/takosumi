import { describe, expect, test } from "bun:test";
import type { ResourceDeploymentAdmission } from "takosumi-contract/resource-deployment";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { resourceDeploymentAdmissionFromEnv } from "../../../worker/src/worker_service.ts";

function envWith(value: unknown): CloudflareWorkerEnv {
  return {
    TAKOSUMI_RESOURCE_DEPLOYMENT_ADMISSION: value,
  } as CloudflareWorkerEnv;
}

const admission: ResourceDeploymentAdmission = {
  async quote() {
    return undefined;
  },
  async reserve() {
    return { reasons: [] };
  },
  async capture() {},
  async markSettlementPending() {},
  async release() {},
};

describe("Resource deployment admission Worker composition", () => {
  test("keeps the OSS default unpriced when no host port is installed", () => {
    expect(
      resourceDeploymentAdmissionFromEnv(envWith(undefined)),
    ).toBeUndefined();
  });

  test("passes through a complete host implementation", () => {
    expect(resourceDeploymentAdmissionFromEnv(envWith(admission))).toBe(
      admission,
    );
  });

  test("fails closed for a partial host implementation", () => {
    expect(() =>
      resourceDeploymentAdmissionFromEnv(
        envWith({
          quote: admission.quote,
          reserve: admission.reserve,
          capture: admission.capture,
          release: admission.release,
        }),
      ),
    ).toThrow("must implement quote(), reserve(), capture()");
  });
});
