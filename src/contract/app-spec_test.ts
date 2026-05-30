import { assertEquals } from "jsr:@std/assert@^1.0.6";
import {
  isComponentOutputRef,
  isPlatformServicePath,
  isPlatformServiceRef,
} from "./app-spec.ts";

Deno.test("AppSpec output and service path helpers distinguish local and platform refs", () => {
  assertEquals(isComponentOutputRef("db.connection"), true);
  assertEquals(isComponentOutputRef("identity.primary.oidc"), false);

  assertEquals(isPlatformServicePath("identity.primary.oidc"), true);
  assertEquals(isPlatformServiceRef("identity.primary.oidc"), true);
  assertEquals(isPlatformServicePath("db.connection"), false);
});

Deno.test("AppSpec platform service path helper rejects malformed paths", () => {
  assertEquals(isPlatformServicePath("Identity.primary.oidc"), false);
  assertEquals(isPlatformServicePath("identity..oidc"), false);
  assertEquals(isPlatformServicePath("identity.primary"), false);
  assertEquals(
    isPlatformServicePath(
      "a.b.c.d.e.f.g.h.i",
    ),
    false,
  );
});
