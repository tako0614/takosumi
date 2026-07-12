import { expect, test } from "bun:test";
import { validateLiveTargetTransport } from "./resource-shape-opentofu-provider.ts";

test("live Resource Shape proof requires an explicit compat endpoint for virtual Cloudflare accounts", () => {
  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "ts_acc_operator",
    }),
  ).toThrow(/target-provider-base-url/);

  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "ts_acc_operator",
      targetProviderBaseUrl: "http://localhost/compat/cloudflare/client/v4",
    }),
  ).toThrow(/HTTPS/);

  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "ts_acc_operator",
      targetProviderBaseUrl:
        "https://operator.example/compat/cloudflare/client/v4",
    }),
  ).not.toThrow();
});

test("live Resource Shape proof leaves real provider targets and other adapters unchanged", () => {
  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "0123456789abcdef0123456789abcdef",
    }),
  ).not.toThrow();
  expect(() =>
    validateLiveTargetTransport({
      targetType: "kubernetes",
      targetRef: "cluster-prod",
    }),
  ).not.toThrow();
});
