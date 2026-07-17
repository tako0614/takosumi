import { expect, test } from "bun:test";
import {
  createMobilePushHostRegistrationRequest,
  isMobileProductKind,
  MOBILE_PUSH_REGISTRATION_PATH,
  parseMobilePushHostRegistrationRequest,
  type MobilePushClientRegistration,
  type MobilePushHostRegistrationRequest,
} from "../../contract/mobile.ts";

test("mobile contract exposes the standard product host push endpoint", () => {
  expect(MOBILE_PUSH_REGISTRATION_PATH).toBe("/api/mobile/push-registrations");
});

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

test("createMobilePushHostRegistrationRequest builds the shared wire payload", () => {
  const payload = createMobilePushHostRegistrationRequest({
    hostUrl: "https://takos.test",
    product: "takos",
    registration: {
      token: "push-token",
      provider: "fcm",
      environment: "development",
    },
  });

  expect(payload).toEqual({
    product: "takos",
    token: "push-token",
    environment: "development",
    host_url: "https://takos.test",
  } satisfies MobilePushHostRegistrationRequest);
});

test("parseMobilePushHostRegistrationRequest normalizes shared host payloads", () => {
  const result = parseMobilePushHostRegistrationRequest(
    {
      product: "yurucommu",
      token: " push-token ",
      host_url: "https://yurucommu.test/",
    },
    { product: "yurucommu" },
  );

  expect(result).toEqual({
    ok: true,
    value: {
      product: "yurucommu",
      token: "push-token",
      environment: "production",
      hostUrl: "https://yurucommu.test",
    },
  });
});

test("parseMobilePushHostRegistrationRequest rejects malformed host payloads", () => {
  expect(
    parseMobilePushHostRegistrationRequest(
      {
        product: "yurucommu",
        token: "push-token",
      },
      { product: "takos" },
    ),
  ).toEqual({
    ok: false,
    error: {
      code: "BAD_REQUEST",
      error: "product must be takos",
      field: "product",
    },
  });

  expect(
    parseMobilePushHostRegistrationRequest({
      product: "takos",
      token: "push-token",
      host_url: "ftp://takos.test",
    }),
  ).toEqual({
    ok: false,
    error: {
      code: "BAD_REQUEST",
      error: "host_url is invalid",
      field: "host_url",
    },
  });
});
