import { describe, expect, test } from "bun:test";
import { sanitizeTcsListingSource } from "../../../../dashboard/src/lib/tcs-client.ts";

const TCS_LISTING_SOURCE_FIXTURES = [
  {
    name: "canonical nested module",
    input: {
      git: "https://GitHub.com/Acme/Widget.git/",
      path: "./Modules/OpenTofu/",
    },
    expected: {
      git: "https://github.com/Acme/Widget",
      path: "Modules/OpenTofu",
    },
  },
  {
    name: "root path",
    input: { git: "https://example.com/acme/widget.git", path: "" },
    expected: { git: "https://example.com/acme/widget", path: "." },
  },
  {
    name: "parent traversal",
    input: { git: "https://example.com/acme/widget", path: "../secret" },
  },
  {
    name: "credential query",
    input: {
      git: "https://example.com/acme/widget.git?token=secret",
      path: ".",
    },
  },
  {
    name: "extra ref authority",
    input: {
      git: "https://example.com/acme/widget",
      ref: "main",
      path: ".",
    },
  },
] as const;

describe("dashboard TCS source adapter", () => {
  for (const fixture of TCS_LISTING_SOURCE_FIXTURES) {
    test(fixture.name, () => {
      if (!fixture.expected) {
        expect(() => sanitizeTcsListingSource(fixture.input)).toThrow(
          "canonical TCS",
        );
        return;
      }
      expect(sanitizeTcsListingSource(fixture.input)).toEqual({
        url: fixture.expected.git,
        path: fixture.expected.path,
      });
    });
  }
});
