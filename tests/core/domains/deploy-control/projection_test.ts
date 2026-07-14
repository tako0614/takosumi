import { expect, test } from "bun:test";

import {
  errorDiagnostic,
  projectAllWorkspaceOutputs,
  projectOutputAllowlistPublicOutputs,
  projectOutputAllowlistSpaceOutputs,
  WORKSPACE_OUTPUT_PROJECTION_LIMITS,
} from "../../../../core/domains/deploy-control/projection.ts";
import {
  OpenTofuControllerError,
  OpenTofuRunnerExecutionError,
  runErrorCode,
} from "../../../../core/domains/deploy-control/errors.ts";

test("Workspace Output capture preserves opaque non-sensitive JSON while public projection filters it", () => {
  const outputs = {
    config: {
      sensitive: false,
      value: {
        endpoint: "https://api.example.test",
        database: { password: "do-not-project" },
      },
    },
  };

  expect(
    projectOutputAllowlistSpaceOutputs(
      {
        config: {
          from: "config",
          type: "json",
          required: false,
        },
      },
      outputs,
    ),
  ).toEqual({
    config: {
      endpoint: "https://api.example.test",
      database: { password: "do-not-project" },
    },
  });

  expect(
    projectOutputAllowlistPublicOutputs(
      {
        config: {
          from: "config",
          type: "json",
          required: false,
        },
      },
      outputs,
    ),
  ).toEqual({});
});

test("ordinary root outputs are captured without requiring an allowlist", () => {
  expect(
    projectAllWorkspaceOutputs({
      endpoint: {
        sensitive: false,
        value: "https://api.example.test",
      },
      metadata: {
        sensitive: false,
        value: { region: "example-1" },
      },
      token: {
        sensitive: true,
        value: "must-not-cross-the-runner-boundary",
      },
    }),
  ).toEqual({
    endpoint: "https://api.example.test",
    metadata: { region: "example-1" },
  });
});

test("output allowlist projection never publishes entries marked sensitive by config", () => {
  const outputs = {
    private_signing_material: {
      sensitive: false,
      value: "raw-signing-key",
    },
  };
  const allowlist = {
    private_signing_material: {
      from: "private_signing_material",
      type: "string",
      sensitive: true,
    },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({});
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual({});
});

test("Workspace Output capture does not infer sensitivity from source names", () => {
  const allowlist = {
    status: { from: "api_token", type: "string" },
  } as const;
  const outputs = {
    api_token: { sensitive: false, value: "healthy" },
  };

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({
    status: "healthy",
  });
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual({});
});

test("required opaque JSON is captured locally but fails closed at public projection", () => {
  const outputs = {
    config: {
      sensitive: false,
      value: {
        endpoint: "https://api.example.test",
        token: "do-not-project",
      },
    },
  };

  const allowlist = {
    config: {
      from: "config",
      type: "json",
      required: true,
    },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({
    config: {
      endpoint: "https://api.example.test",
      token: "do-not-project",
    },
  });
  expect(() => projectOutputAllowlistPublicOutputs(allowlist, outputs)).toThrow(
    "cannot be published",
  );
});

test("former runtime declaration names remain ordinary opaque Outputs", () => {
  const allowlist = {
    app_deployment: {
      from: "app_deployment",
      type: "json",
      required: true,
    },
    service_exports: {
      from: "ordinary_json",
      type: "json",
      required: true,
    },
    renamed_bindings: {
      from: "service_bindings",
      type: "json",
      required: true,
    },
  } as const;
  const outputs = {
    app_deployment: { sensitive: false, value: { name: "legacy-app" } },
    ordinary_json: { sensitive: false, value: [{ name: "legacy-service" }] },
    service_bindings: { sensitive: false, value: [{ name: "legacy-binding" }] },
  };

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({
    app_deployment: { name: "legacy-app" },
    renamed_bindings: [{ name: "legacy-binding" }],
    service_exports: [{ name: "legacy-service" }],
  });
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual({
    app_deployment: { name: "legacy-app" },
    service_exports: [{ name: "legacy-service" }],
    renamed_bindings: [{ name: "legacy-binding" }],
  });
});

test("output allowlist projection drops optional empty generated output shims", () => {
  const outputs = {
    url: {
      sensitive: false,
      value: "",
    },
    worker_name: {
      sensitive: false,
      value: "",
    },
  };

  const allowlist = {
    url: {
      from: "url",
      type: "url",
    },
    worker_name: {
      from: "worker_name",
      type: "string",
    },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({});
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual({});
});

test("output allowlist projection drops optional outputs removed by destroy", () => {
  const outputs = {
    launch_url: {
      sensitive: false,
      value: null,
    },
  };
  const optional = {
    launch_url: {
      from: "launch_url",
      type: "url",
    },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(optional, outputs)).toEqual({});
  expect(projectOutputAllowlistPublicOutputs(optional, outputs)).toEqual({});

  expect(() =>
    projectOutputAllowlistSpaceOutputs(
      {
        launch_url: {
          from: "launch_url",
          type: "url",
          required: true,
        },
      },
      outputs,
    ),
  ).toThrow("does not match declared projection type url");
});

test("Workspace Output capture skips optional values that exceed its per-value bound", () => {
  const oversized = "x".repeat(
    WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxValueBytes,
  );

  expect(
    projectOutputAllowlistSpaceOutputs(
      { payload: { from: "payload", type: "json" } },
      { payload: { sensitive: false, value: oversized } },
    ),
  ).toEqual({});
});

test("Workspace Output capture is deterministically bounded by count and total bytes", () => {
  const countAllowlist = Object.fromEntries(
    Array.from(
      { length: WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxEntries + 1 },
      (_, index) => {
        const name = `output_${String(index).padStart(3, "0")}`;
        return [name, { from: name, type: "json" as const }];
      },
    ),
  );
  const countOutputs = Object.fromEntries(
    Object.keys(countAllowlist).map((name) => [
      name,
      { sensitive: false, value: name },
    ]),
  );
  const countProjection = projectOutputAllowlistSpaceOutputs(
    countAllowlist,
    countOutputs,
  );
  expect(Object.keys(countProjection)).toHaveLength(
    WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxEntries,
  );
  expect(countProjection).not.toHaveProperty("output_128");

  const chunk = "x".repeat(32 * 1024);
  const totalAllowlist = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `chunk_${index}`,
      { from: `chunk_${index}`, type: "json" as const },
    ]),
  );
  const totalOutputs = Object.fromEntries(
    Object.keys(totalAllowlist).map((name) => [
      name,
      { sensitive: false, value: chunk },
    ]),
  );
  const totalProjection = projectOutputAllowlistSpaceOutputs(
    totalAllowlist,
    totalOutputs,
  );
  expect(Object.keys(totalProjection).length).toBeLessThan(9);
  expect(
    new TextEncoder().encode(JSON.stringify(totalProjection)).byteLength,
  ).toBeLessThanOrEqual(
    WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxTotalBytes + 9 * 32,
  );
});

test("explicit public string outputs allow ordinary labels containing secret words", () => {
  const outputAllowlist = {
    worker_name: { from: "worker_name", type: "string" },
    url: { from: "url", type: "string" },
  } as const;

  expect(
    projectOutputAllowlistPublicOutputs(outputAllowlist, {
      worker_name: {
        sensitive: false,
        value: "takosumi-credential-recipes-demo",
      },
      url: {
        sensitive: false,
        value: "https://takosumi-credential-recipes-demo.example.test",
      },
    }),
  ).toEqual({
    worker_name: "takosumi-credential-recipes-demo",
    url: "https://takosumi-credential-recipes-demo.example.test",
  });
});

test("explicit url outputs reject credential-bearing query parameters regardless of Output name", () => {
  const outputAllowlist = {
    endpoint: { from: "ordinary_result", type: "url", required: true },
  } as const;

  expect(() =>
    projectOutputAllowlistPublicOutputs(outputAllowlist, {
      ordinary_result: {
        sensitive: false,
        value: "https://api.example.test/invoke?access_token=secret-value",
      },
    }),
  ).toThrow("cannot be published");
});

test("structured error reasons preserve an injected billing extension denial", () => {
  expect(
    runErrorCode(
      new OpenTofuControllerError(
        "failed_precondition",
        "billing extension denied the operation",
        { reason: "credits_required" },
      ),
      "run_failed",
    ),
  ).toBe("credits_required");

  expect(
    runErrorCode(
      new Error(
        "credits_required: the injected policy reported insufficient capacity",
      ),
      "run_failed",
    ),
  ).toBe("run_failed");
});

test("error diagnostics do not infer host billing semantics from free-form text", () => {
  const diagnostic = errorDiagnostic(
    new Error("billing extension reported insufficient credits"),
  );

  expect(diagnostic).toEqual({
    severity: "error",
    message: "billing extension reported insufficient credits",
  });
});

test("error diagnostics carry an explicit structured reason separately from prose", () => {
  const diagnostic = errorDiagnostic(
    new OpenTofuControllerError(
      "failed_precondition",
      "the reviewed connection changed",
      { reason: "provider_connection_changed" },
    ),
  );

  expect(diagnostic).toEqual({
    severity: "error",
    code: "provider_connection_changed",
    message: "the reviewed connection changed",
  });
});

test("structured error reasons classify provider credential preparation failures", () => {
  expect(
    runErrorCode(
      new OpenTofuControllerError(
        "failed_precondition",
        "the selected connection is pending verification",
        { reason: "provider_connection_not_ready" },
      ),
      "run_failed",
    ),
  ).toBe("provider_connection_not_ready");

  expect(
    runErrorCode(
      new OpenTofuControllerError(
        "failed_precondition",
        "a connection must be selected",
        { reason: "provider_connection_setup_required" },
      ),
      "run_failed",
    ),
  ).toBe("provider_connection_setup_required");

  expect(
    runErrorCode(
      new OpenTofuControllerError(
        "failed_precondition",
        "the reviewed bindings no longer match",
        { reason: "provider_connection_changed" },
      ),
      "run_failed",
    ),
  ).toBe("provider_connection_changed");

  expect(
    runErrorCode(
      new OpenTofuControllerError(
        "failed_precondition",
        "credential preparation is unavailable",
        { reason: "credential_service_unavailable" },
      ),
      "run_failed",
    ),
  ).toBe("credential_service_unavailable");
});

test("runner adapters preserve concrete provider runtime reasons", () => {
  expect(
    runErrorCode(
      new OpenTofuRunnerExecutionError("registry lookup failed", {
        reason: "provider_package_unavailable",
      }),
      "plan_failed",
    ),
  ).toBe("provider_package_unavailable");
  expect(
    runErrorCode(
      new OpenTofuRunnerExecutionError("init exited 1", {
        reason: "opentofu_init_failed",
      }),
      "plan_failed",
    ),
  ).toBe("opentofu_init_failed");
});

test("explicit public string outputs still reject concrete secret-shaped values", () => {
  const outputAllowlist = {
    worker_name: { from: "worker_name", type: "string", required: true },
  } as const;

  expect(() =>
    projectOutputAllowlistPublicOutputs(outputAllowlist, {
      worker_name: {
        sensitive: false,
        value: "token=abc123",
      },
    }),
  ).toThrow("cannot be published");
});
