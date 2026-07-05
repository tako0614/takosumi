import { expect, test } from "bun:test";

import {
  projectOutputAllowlistPublicOutputs,
  projectOutputAllowlistSpaceOutputs,
  projectTemplatePublicOutputs,
} from "../../../../core/domains/deploy-control/projection.ts";

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
        app_deployment: { from: "app_deployment", type: "json", required: true },
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
