import { expect, test } from "bun:test";
import { validateLiveTargetTransport } from "./resource-shape-opentofu-provider.ts";

test("live Resource Shape proof rejects retired virtual Cloudflare target refs", () => {
  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "ts_acc_operator",
      targetProviderBaseUrl: "https://operator.example.test/provider/v1",
    }),
  ).toThrow(/retired virtual Cloudflare target refs/);

  expect(() =>
    validateLiveTargetTransport({
      targetType: "cloudflare",
      targetRef: "ts_acc_operator",
    }),
  ).toThrow(/real provider-native account id/);
});

test("live Resource Shape proof permits real provider targets and other adapters", () => {
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
