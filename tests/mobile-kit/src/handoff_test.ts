import { expect, test } from "bun:test";
import {
  parseMobileConnectInput,
  parseMobileRouteInput,
} from "../../../mobile-kit/src/index.ts";

test("parseMobileConnectInput accepts plain host URLs", () => {
  expect(parseMobileConnectInput("host.example/path")).toEqual({
    hostUrl: "https://host.example",
    product: undefined,
    setupTicket: undefined,
  });
});

test("parseMobileConnectInput accepts app handoff URLs", () => {
  expect(
    parseMobileConnectInput(
      "yurucommu://connect?host_url=https%3A%2F%2Fy.example%2Ffeed&product=yurucommu&setup_ticket=s1",
    ),
  ).toEqual({
    hostUrl: "https://y.example",
    product: "yurucommu",
    setupTicket: "s1",
  });
});

test("parseMobileConnectInput accepts JSON QR payloads", () => {
  expect(
    parseMobileConnectInput(
      JSON.stringify({
        host_url: "https://takos.example/workspace",
        product: "takos",
      }),
    ),
  ).toEqual({
    hostUrl: "https://takos.example",
    product: "takos",
    setupTicket: undefined,
  });
});

test("parseMobileRouteInput accepts mobile open URLs", () => {
  expect(
    parseMobileRouteInput(
      "takos://open?path=%2Fchat&host_url=https%3A%2F%2Fhost.example%2Fworkspace&product=takos",
      { mobileScheme: "takos", product: "takos" },
    ),
  ).toEqual({
    path: "/chat",
    hostUrl: "https://host.example",
    product: "takos",
  });
});

test("parseMobileRouteInput infers host from absolute route URLs", () => {
  expect(
    parseMobileRouteInput(
      "yurucommu://open?url=https%3A%2F%2Fy.example%2Fnotifications%3Funread%3D1",
      { mobileScheme: "yurucommu", product: "yurucommu" },
    ),
  ).toEqual({
    path: "/notifications?unread=1",
    hostUrl: "https://y.example",
    product: undefined,
  });
});

test("parseMobileRouteInput ignores connect URLs and rejects mismatched products", () => {
  expect(
    parseMobileRouteInput("takos://connect?host_url=https%3A%2F%2Fhost.example", {
      mobileScheme: "takos",
      product: "takos",
    }),
  ).toBeUndefined();
  expect(() =>
    parseMobileRouteInput("takos://open?path=%2Fchat&product=yurucommu", {
      mobileScheme: "takos",
      product: "takos",
    }),
  ).toThrow("Mobile route payload product mismatch.");
});
