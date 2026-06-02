import { expect, test } from "bun:test";

import {
  createOpenTofuPlatformServiceResolver,
  parseOpenTofuOutputs,
} from "./opentofu-output-resolver.ts";

const OUTPUTS = {
  oidc_issuer_url: {
    sensitive: false,
    type: "string",
    value: "https://accounts.example.test",
  },
  oidc_client_id: {
    sensitive: false,
    type: "string",
    value: "toc_app",
  },
  oidc_client_secret: {
    sensitive: true,
    type: "string",
    value: "secret-value",
  },
  object_store: {
    sensitive: false,
    type: ["object", { bucket: "string", endpoint: "string" }],
    value: {
      bucket: "app-assets",
      endpoint: "https://r2.example.test",
    },
  },
};

test("parseOpenTofuOutputs reads tofu output -json shape", () => {
  expect(parseOpenTofuOutputs(JSON.stringify(OUTPUTS))).toEqual(OUTPUTS);
});

test("createOpenTofuPlatformServiceResolver resolves a service path", () => {
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: OUTPUTS,
    services: [
      {
        path: "identity.primary.oidc",
        kind: "identity.oidc@v1",
        material: {
          issuerUrl: "oidc_issuer_url",
          clientId: "oidc_client_id",
          clientSecret: "oidc_client_secret",
        },
      },
    ],
  });

  expect(resolver.resolve({
    binding: { servicePath: "identity.primary.oidc" },
  })).toEqual([
    {
      path: "identity.primary.oidc",
      kind: "identity.oidc@v1",
      material: {
        issuerUrl: "https://accounts.example.test",
        clientId: "toc_app",
      },
    },
  ]);
});

test("createOpenTofuPlatformServiceResolver can explicitly include sensitive outputs", () => {
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: OUTPUTS,
    includeSensitiveOutputs: true,
    services: [
      {
        path: "identity.primary.oidc",
        kind: "identity.oidc@v1",
        material: {
          clientSecret: "oidc_client_secret",
        },
      },
    ],
  });

  expect(resolver.resolve({
    binding: { servicePath: "identity.primary.oidc" },
  })).toEqual([
    {
      path: "identity.primary.oidc",
      kind: "identity.oidc@v1",
      material: {
        clientSecret: "secret-value",
      },
    },
  ]);
});

test("createOpenTofuPlatformServiceResolver resolves kind and labels", () => {
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: OUTPUTS,
    services: [
      {
        path: "storage.assets",
        kind: "object-store",
        labels: { profile: "assets" },
        material: { r2: "object_store" },
      },
      {
        path: "storage.backups",
        kind: "object-store",
        labels: { profile: "backups" },
      },
    ],
  });

  expect(resolver.resolve({
    binding: { serviceKind: "object-store", labels: { profile: "assets" } },
  })).toEqual([
    {
      path: "storage.assets",
      kind: "object-store",
      labels: { profile: "assets" },
      material: {
        r2: {
          bucket: "app-assets",
          endpoint: "https://r2.example.test",
        },
      },
    },
  ]);
});

test("createOpenTofuPlatformServiceResolver keeps inventory space-scoped", () => {
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: OUTPUTS,
    services: [
      {
        spaceId: "space_alpha",
        path: "identity.primary.oidc",
        kind: "identity.oidc@v1",
        material: { issuerUrl: "oidc_issuer_url" },
      },
      {
        spaceId: "space_beta",
        path: "identity.primary.oidc",
        kind: "identity.oidc@v1",
        material: { clientId: "oidc_client_id" },
      },
      {
        path: "storage.shared.assets",
        kind: "object-store",
        labels: { visibility: "global" },
        material: { r2: "object_store" },
      },
    ],
  });

  expect(resolver.resolve({
    spaceId: "space_alpha",
    binding: { servicePath: "identity.primary.oidc" },
  })).toEqual([
    {
      path: "identity.primary.oidc",
      kind: "identity.oidc@v1",
      material: { issuerUrl: "https://accounts.example.test" },
    },
  ]);
  expect(resolver.resolve({
    spaceId: "space_beta",
    binding: { servicePath: "identity.primary.oidc" },
  })).toEqual([
    {
      path: "identity.primary.oidc",
      kind: "identity.oidc@v1",
      material: { clientId: "toc_app" },
    },
  ]);
  expect(resolver.resolve({
    binding: { servicePath: "identity.primary.oidc" },
  })).toBeUndefined();
  expect(resolver.resolve({
    binding: { serviceKind: "object-store", labels: { visibility: "global" } },
  })).toEqual([
    {
      path: "storage.shared.assets",
      kind: "object-store",
      labels: { visibility: "global" },
      material: {
        r2: {
          bucket: "app-assets",
          endpoint: "https://r2.example.test",
        },
      },
    },
  ]);
});

test("createOpenTofuPlatformServiceResolver validates ambiguous space scopes", () => {
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: OUTPUTS,
    services: [
      {
        spaceId: "space_alpha",
        spaceIds: ["space_beta"],
        path: "identity.primary.oidc",
        kind: "identity.oidc@v1",
      },
    ],
  });

  expect(() =>
    resolver.resolve({
      spaceId: "space_alpha",
      binding: { servicePath: "identity.primary.oidc" },
    })
  ).toThrow("spaceId or spaceIds");
});

test("createOpenTofuPlatformServiceResolver rejects missing outputs", () => {
  expect(() =>
    createOpenTofuPlatformServiceResolver({
      outputs: OUTPUTS,
      services: [
        {
          path: "identity.primary.oidc",
          kind: "identity.oidc@v1",
          material: { issuerUrl: "missing_output" },
        },
      ],
    })
  ).toThrow("OpenTofu output missing_output is not available");
});
