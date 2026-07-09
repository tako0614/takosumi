import { expect, test } from "bun:test";

import {
  errorDiagnostic,
  projectOutputAllowlistPublicOutputs,
  projectOutputAllowlistSpaceOutputs,
  projectTemplatePublicOutputs,
} from "../../../../core/domains/deploy-control/projection.ts";
import { compactErrorCode } from "../../../../core/domains/deploy-control/projection_run.ts";

test("output allowlist projection drops optional nested JSON secret material", () => {
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
  ).toEqual({});

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
  ).toEqual([]);
});

test("output allowlist projection never publishes entries marked sensitive by config", () => {
  const outputs = {
    takos_storage_signing_key: {
      sensitive: false,
      value: "raw-signing-key",
    },
  };
  const allowlist = {
    takos_storage_signing_key: {
      from: "takos_storage_signing_key",
      type: "string",
      sensitive: true,
    },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({});
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual([]);
});

test("output allowlist projection fails closed for required nested JSON secret material", () => {
  const outputs = {
    config: {
      sensitive: false,
      value: {
        endpoint: "https://api.example.test",
        token: "do-not-project",
      },
    },
  };

  expect(() =>
    projectOutputAllowlistSpaceOutputs(
      {
        config: {
          from: "config",
          type: "json",
          required: true,
        },
      },
      outputs,
    ),
  ).toThrow("cannot be projected");
});

test("output allowlist projection accepts app_deployment service projection with resource descriptors", () => {
  const outputs = {
    app_deployment: {
      sensitive: false,
      value: {
        name: "yurucommu",
        version: "2.0.0",
        compute: {
          web: {
            kind: "worker",
            consume: [
              {
                publication: "identity.oidc",
                inject: {
                  env: {
                    issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
                    clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
                  },
                },
              },
            ],
          },
        },
        resources: {
          database: {
            type: "sql",
            bind: "DB",
            to: ["web"],
          },
          media: {
            type: "object-store",
            bind: "MEDIA",
            to: ["web"],
          },
        },
        publish: [
          {
            name: "launcher",
            publisher: "web",
            type: "UiSurface",
            outputs: { url: { kind: "url", routeRef: "root" } },
          },
        ],
      },
    },
  };
  const allowlist = {
    app_deployment: { from: "app_deployment", type: "json", required: true },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({
    app_deployment: outputs.app_deployment.value,
  });
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual([
    {
      name: "app_deployment",
      kind: "json",
      value: outputs.app_deployment.value,
      sensitive: false,
    },
  ]);
});

test("output allowlist projection still rejects app_deployment values with concrete secret material", () => {
  const outputs = {
    app_deployment: {
      sensitive: false,
      value: {
        name: "bad-app",
        password: "sk_test_1234567890abcdef",
      },
    },
  };

  expect(() =>
    projectOutputAllowlistSpaceOutputs(
      {
        app_deployment: {
          from: "app_deployment",
          type: "json",
          required: true,
        },
      },
      outputs,
    ),
  ).toThrow("cannot be projected");
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
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual([]);
});

test("template public string outputs allow ordinary labels containing secret words", () => {
  const template = {
    id: "cloudflare-hello-worker",
    version: "1.0.0",
    outputs: {
      public: {
        worker_name: { from: "worker_name", type: "string" },
        url: { from: "url", type: "string" },
      },
    },
  } as const;

  expect(
    projectTemplatePublicOutputs(template as never, {
      worker_name: {
        sensitive: false,
        value: "takosumi-credential-recipes-demo",
      },
      url: {
        sensitive: false,
        value: "https://takosumi-credential-recipes-demo.example.test",
      },
    }),
  ).toEqual([
    {
      name: "worker_name",
      kind: "string",
      value: "takosumi-credential-recipes-demo",
      sensitive: false,
    },
    {
      name: "url",
      kind: "string",
      value: "https://takosumi-credential-recipes-demo.example.test",
      sensitive: false,
    },
  ]);
});

test("compact error codes classify managed Cloud credit gates as credit-required", () => {
  expect(
    compactErrorCode(
      'OpenTofu runner rejected apply run plan_123: 500 (POST "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/d1/database": 402 Payment Required {"error":"cloud_extension_insufficient_credits","reason":"insufficient_credits"})',
    ),
  ).toBe("credits_required");

  expect(
    compactErrorCode(
      "USD balance reservation failed: $0.01 estimated but only $0.00 available",
    ),
  ).toBe("credits_required");
});

test("error diagnostics summarize managed Cloud credit gates before raw runner detail", () => {
  const diagnostic = errorDiagnostic(
    new Error(
      'OpenTofu runner rejected apply run plan_123: 500 (POST "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/d1/database": 402 Payment Required {"error":"cloud_extension_insufficient_credits","reason":"insufficient_credits"})',
    ),
  );

  expect(diagnostic.message).toBe(
    "credits_required: insufficient credits for this Takosumi Cloud operation",
  );
  expect(diagnostic.detail).toContain("OpenTofu runner rejected apply run");
  expect(diagnostic.detail).toContain("cloud_extension_insufficient_credits");
});

test("compact error codes classify provider credential preparation failures", () => {
  expect(
    compactErrorCode(
      "credential_mint_failed: connection conn_operator_takosumi_cloud_cloudflare_compat is pending (not verified)",
    ),
  ).toBe("provider_connection_not_ready");

  expect(
    compactErrorCode(
      "credential_mint_failed: installation provider connection resolution is required",
    ),
  ).toBe("provider_connection_setup_required");

  expect(
    compactErrorCode(
      "resolved_bindings_changed: plan run plan_123 was reviewed against different provider connections than are now resolved; re-plan before apply",
    ),
  ).toBe("provider_connection_changed");

  expect(
    compactErrorCode(
      "credential_mint_failed: managed provider connection conn_cloud requires a managed provider credential issuer",
    ),
  ).toBe("credential_service_unavailable");
});

test("template public string outputs still reject concrete secret-shaped values", () => {
  const template = {
    id: "cloudflare-hello-worker",
    version: "1.0.0",
    outputs: {
      public: {
        worker_name: { from: "worker_name", type: "string" },
      },
    },
  } as const;

  expect(() =>
    projectTemplatePublicOutputs(template as never, {
      worker_name: {
        sensitive: false,
        value: "token=abc123",
      },
    }),
  ).toThrow("cannot be published");
});
