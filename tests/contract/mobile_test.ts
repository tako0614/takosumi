import { expect, test } from "bun:test";
import {
  isMobileProductKind,
  type MobilePushClientRegistration,
} from "../../contract/mobile.ts";

test("mobile contract accepts product keys and rejects unsafe keys", () => {
  expect(isMobileProductKind("takos")).toBe(true);
  expect(isMobileProductKind("notes-app")).toBe(true);
  expect(isMobileProductKind("bad/product")).toBe(false);
});

test("mobile push registration identifies the native provider and environment", () => {
  const registration = {
    token: "native-token",
    provider: "apns",
    environment: "sandbox",
  } satisfies MobilePushClientRegistration;

  expect(registration).toEqual({
    token: "native-token",
    provider: "apns",
    environment: "sandbox",
  });
});
