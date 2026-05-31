import { expect, test } from "bun:test";

import {
  isComponentOutputRef,
  isPlatformServicePath,
  isPlatformServiceRef,
} from "./app-spec.ts";

test("AppSpec output and service path helpers distinguish local and platform refs", () => {
  expect(isComponentOutputRef("db.connection")).toEqual(true);
  expect(isComponentOutputRef("identity.primary.oidc")).toEqual(false);

  expect(isPlatformServicePath("identity.primary.oidc")).toEqual(true);
  expect(isPlatformServiceRef("identity.primary.oidc")).toEqual(true);
  expect(isPlatformServicePath("db.connection")).toEqual(false);
});

test("AppSpec platform service path helper rejects malformed paths", () => {
  expect(isPlatformServicePath("Identity.primary.oidc")).toEqual(false);
  expect(isPlatformServicePath("identity..oidc")).toEqual(false);
  expect(isPlatformServicePath("identity.primary")).toEqual(false);
  expect(isPlatformServicePath(
      "a.b.c.d.e.f.g.h.i",
    )).toEqual(false);
});
