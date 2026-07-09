import { expect, test } from "bun:test";
import {
  copyMobileText,
  createFirstRunActions,
  createMobileReturnUri,
  type MobileProductAdapter,
} from "../../../mobile-kit/src/index.ts";
import { defineMobileHostActions } from "../../../mobile-kit/src/host-actions.ts";

const adapter: MobileProductAdapter = {
  product: "takos",
  appName: "Takos",
  hostNoun: "Takos host",
  hostCenterLabel: "Host Takos",
  hostCenterSource: {
    git: "https://github.com/acme/takos.git",
    path: "deploy/opentofu",
  },
  urlPlaceholder: "https://workspace.example.com",
  primaryActionLabel: "Connect",
  accentColor: "#166534",
  mobileScheme: "takos",
};

test("createMobileReturnUri builds product-specific deep link returns", () => {
  expect(createMobileReturnUri(adapter)).toBe("takos://connect");
  expect(createMobileReturnUri(adapter, "/oauth/callback")).toBe(
    "takos://oauth/callback",
  );
});

test("createFirstRunActions exposes URL, payload, and host actions", () => {
  expect(createFirstRunActions(adapter).map((action) => action.id)).toEqual([
    "url",
    "qr",
    "host",
  ]);
});

test("createFirstRunActions can hide Host Center action for Host Center-only adapters", () => {
  expect(
    createFirstRunActions({
      ...adapter,
      product: "notes-app",
      appName: "Notes",
      hostNoun: "Notes host",
      hostCenterLabel: undefined,
      mobileScheme: "notesapp",
    }).map((action) => action.id),
  ).toEqual(["url", "qr"]);
});

test("defineMobileHostActions validates static same-origin host paths", () => {
  const actions = defineMobileHostActions([
    { label: "Home", description: "Open home.", path: "/" },
    { label: "Settings", description: "Open settings.", path: "/settings" },
  ]);

  expect(actions.map((action) => action.path)).toEqual(["/", "/settings"]);
  expect(() =>
    defineMobileHostActions([
      {
        label: "Bad",
        description: "Open remote.",
        path: "https://evil.example",
      },
    ]),
  ).toThrow("Host action path must be same-origin: Bad");
  expect(() =>
    defineMobileHostActions([
      { label: "Blank", description: " ", path: "/blank" },
    ]),
  ).toThrow("Host action description is required: Blank");
});

test("copyMobileText writes through the native clipboard seam", async () => {
  const writes: unknown[] = [];
  await copyMobileText({
    text: "https://host.example",
    label: "Host URL",
    async writeClipboardText(input) {
      writes.push(input);
    },
  });

  expect(writes).toEqual([
    {
      text: "https://host.example",
      label: "Host URL",
    },
  ]);
});

test("copyMobileText reports unavailable clipboard support", async () => {
  await expect(
    copyMobileText({
      text: "https://host.example",
      unavailableMessage: "Copy is unavailable.",
    }),
  ).rejects.toThrow("Copy is unavailable.");
});
