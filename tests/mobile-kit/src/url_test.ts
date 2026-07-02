import { expect, test } from "bun:test";
import {
  createMobileConnectUrl,
  createMobileHostRouteUrl,
  createTakosumiHostCenterUrl,
  hostEndpoint,
  normalizeHostUrl,
} from "../../../mobile-kit/src/index.ts";

test("normalizeHostUrl canonicalizes host origins", () => {
  expect(normalizeHostUrl("example.com/path?x=1")).toBe("https://example.com");
  expect(normalizeHostUrl("http://localhost:8787/a")).toBe(
    "http://localhost:8787",
  );
});

test("hostEndpoint rejects cross-origin absolute endpoints", () => {
  expect(hostEndpoint("https://host.example", "/api/auth/me")).toBe(
    "https://host.example/api/auth/me",
  );
  expect(
    hostEndpoint(
      "https://host.example/base",
      "https://host.example/api/mobile/push-registrations",
    ),
  ).toBe("https://host.example/api/mobile/push-registrations");
  expect(() =>
    hostEndpoint("https://host.example", "https://evil.example/api"),
  ).toThrow("Host endpoint must stay on the connected host.");
});

test("createTakosumiHostCenterUrl points at Host Center entry", () => {
  expect(
    createTakosumiHostCenterUrl({
      product: "notes-app",
      source: {
        git: "https://github.com/acme/notes.git",
        ref: "main",
        path: "deploy/opentofu",
      },
      returnUri: "notesapp://connect",
    }),
  ).toBe(
    "https://app.takosumi.com/install?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect&git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=main&path=deploy%2Fopentofu",
  );
  expect(() =>
    createTakosumiHostCenterUrl({
      product: "bad/product",
      source: { git: "https://github.com/acme/notes.git" },
      returnUri: "notesapp://connect",
    }),
  ).toThrow("Host Center product key is invalid.");
});

test("createMobileConnectUrl carries only host, product, and setup ticket", () => {
  const url = createMobileConnectUrl({
    scheme: "takos",
    hostUrl: "https://host.example/path",
    product: "takos",
    setupTicket: "ticket-1",
  });
  expect(url).toBe(
    "takos://connect?host_url=https%3A%2F%2Fhost.example&product=takos&setup_ticket=ticket-1",
  );
});

test("createMobileHostRouteUrl opens only same-origin host routes", () => {
  const session = {
    hostUrl: "https://host.example/base",
    product: "takos" as const,
    oidcIssuer: "https://host.example",
    accessToken: "token",
    tokenType: "Bearer",
    createdAt: "2026-06-30T00:00:00.000Z",
  };

  expect(
    createMobileHostRouteUrl(session, "/notifications?filter=unread"),
  ).toBe("https://host.example/notifications?filter=unread");
  expect(() => createMobileHostRouteUrl(session, "notifications")).toThrow(
    "absolute same-origin path",
  );
  expect(() => createMobileHostRouteUrl(session, "//evil.example")).toThrow(
    "absolute same-origin path",
  );
});
