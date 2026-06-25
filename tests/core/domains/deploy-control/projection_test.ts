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

test("output allowlist projection accepts takos_app secret resource descriptors without secret values", () => {
  const outputs = {
    takos_app: {
      sensitive: false,
      value: {
        name: "yurucommu",
        version: "2.0.0",
        resources: {
          auth_password_hash: {
            type: "secret",
            bind: "AUTH_PASSWORD_HASH",
            to: ["web"],
            generate: true,
          },
          session_hash_salt: {
            type: "secret",
            bind: "YURUCOMMU_SESSION_HASH_SALT",
            to: ["web"],
            generate: true,
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
    takos_app: { from: "takos_app", type: "json", required: true },
  } as const;

  expect(projectOutputAllowlistSpaceOutputs(allowlist, outputs)).toEqual({
    takos_app: outputs.takos_app.value,
  });
  expect(projectOutputAllowlistPublicOutputs(allowlist, outputs)).toEqual([
    {
      name: "takos_app",
      kind: "json",
      value: outputs.takos_app.value,
      sensitive: false,
    },
  ]);
});

test("output allowlist projection still rejects takos_app values with concrete secret material", () => {
  const outputs = {
    takos_app: {
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
        takos_app: { from: "takos_app", type: "json", required: true },
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
