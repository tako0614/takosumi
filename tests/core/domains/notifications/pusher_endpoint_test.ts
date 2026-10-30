import { expect, test } from "bun:test";

import {
  checkPusherEndpoint,
  parseNotificationPushRelayOrigins,
} from "../../../../core/domains/notifications/pusher_endpoint.ts";

const OWN_RELAY = "https://relay.example.test";

test("the allowlist is exactly the operator's https origins, with no built-in relay", () => {
  expect(parseNotificationPushRelayOrigins(undefined)).toEqual([]);
  expect(parseNotificationPushRelayOrigins("  ")).toEqual([]);
  expect(parseNotificationPushRelayOrigins("[]")).toEqual([]);
  expect(parseNotificationPushRelayOrigins(
    JSON.stringify([OWN_RELAY, `${OWN_RELAY}/`, "https://relay-two.example.test:443"]),
  )).toEqual([OWN_RELAY, "https://relay-two.example.test"]);
});

test("a malformed allowlist refuses to load instead of being ignored", () => {
  for (const value of [
    "https://relay.example.test",
    "{}",
    JSON.stringify(["http://relay.example.test"]),
    JSON.stringify(["https://relay.example.test:8443"]),
    JSON.stringify(["https://relay.example.test/push"]),
    JSON.stringify(["https://user@relay.example.test"]),
    JSON.stringify(["https://relay.example.test?x=1"]),
    JSON.stringify([7]),
    JSON.stringify(Array.from({ length: 17 }, (_, index) => `https://r${index}.example.test`)),
  ]) {
    expect(() => parseNotificationPushRelayOrigins(value)).toThrow(
      "TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS",
    );
  }
});

test("an endpoint must be https on port 443, without userinfo, short, on an allowed origin", () => {
  const allowed = ["https://relay-two.example.test", OWN_RELAY];
  expect(checkPusherEndpoint(`${OWN_RELAY}/push/abc`, allowed)).toEqual({
    ok: true,
    endpoint: `${OWN_RELAY}/push/abc`,
  });
  expect(checkPusherEndpoint(`${OWN_RELAY}:443/push/abc`, allowed)).toEqual({
    ok: true,
    endpoint: `${OWN_RELAY}/push/abc`,
  });
  const refused: Array<[string, string]> = [
    ["not a url", "endpoint_invalid"],
    ["http://relay.example.test/push/abc", "endpoint_not_https"],
    ["https://relay.example.test:8443/push/abc", "endpoint_port_not_443"],
    ["https://user:pass@relay.example.test/push/abc", "endpoint_userinfo"],
    ["https://relay.example.test/push/abc#x", "endpoint_invalid"],
    ["https://elsewhere.example.test/push/abc", "endpoint_origin_not_allowed"],
    ["https://127.0.0.1/push/abc", "endpoint_origin_not_allowed"],
    ["https://push.takosumi.com/push/abc", "endpoint_origin_not_allowed"],
    [`${OWN_RELAY}/${"a".repeat(1024)}`, "endpoint_too_long"],
  ];
  for (const [endpoint, problem] of refused) {
    expect(checkPusherEndpoint(endpoint, allowed)).toEqual({ ok: false, problem });
  }
});
