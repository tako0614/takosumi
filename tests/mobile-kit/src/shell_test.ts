import { expect, test } from "bun:test";
import {
  createFirstRunActions,
  createMobileReturnUri,
  type MobileProductAdapter,
} from "../../../mobile-kit/src/index.ts";

const adapter: MobileProductAdapter = {
  product: "takos",
  appName: "Takos",
  hostNoun: "Takos host",
  hostCenterLabel: "Host Takos",
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
