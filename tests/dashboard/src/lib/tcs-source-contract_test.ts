import { describe, expect, test } from "bun:test";
import { TCS_LISTING_SOURCE_FIXTURES } from "../../../../../takosumi-store/spec/fixtures/listing-source.ts";
import { sanitizeTcsListingSource } from "../../../../dashboard/src/lib/tcs-client.ts";

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
