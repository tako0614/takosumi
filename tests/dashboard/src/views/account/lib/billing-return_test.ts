import { expect, test } from "bun:test";
import {
  buildBillingReturnUrl,
  consumeBillingReturnSearch,
} from "../../../../../../dashboard/src/views/account/lib/billing-return.ts";

test("buildBillingReturnUrl pins checkout result to the paid Workspace", () => {
  expect(
    buildBillingReturnUrl({
      origin: "https://app.takosumi.com",
      checkout: "success",
      spaceId: "space_133669ab2c4c450c",
    }),
  ).toEqual(
    "https://app.takosumi.com/billing?checkout=success&spaceId=space_133669ab2c4c450c",
  );

  expect(
    buildBillingReturnUrl({
      origin: "https://app.takosumi.com",
      checkout: "cancelled",
      spaceId: "not-a-space-id",
    }),
  ).toEqual("https://app.takosumi.com/billing?checkout=cancelled");
});

test("consumeBillingReturnSearch restores the Workspace once and strips transient params", () => {
  expect(
    consumeBillingReturnSearch(
      "?checkout=success&spaceId=space_133669ab2c4c450c&tab=billing",
    ),
  ).toEqual({
    checkoutNotice: "success",
    spaceId: "space_133669ab2c4c450c",
    nextSearch: "tab=billing",
    changed: true,
  });

  expect(
    consumeBillingReturnSearch("?checkout=success&spaceId=javascript:alert(1)"),
  ).toEqual({
    checkoutNotice: "success",
    spaceId: null,
    nextSearch: "",
    changed: true,
  });
});
