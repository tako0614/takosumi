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
