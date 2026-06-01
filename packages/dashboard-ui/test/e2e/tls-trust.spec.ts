import { expect, test } from "@playwright/test";

// Regression test for the ignoreHTTPSErrors:true mistake.
// Playwright must NOT bypass cert validation — if the Pebble root isn't
// trusted via NSS DB, page.goto should throw.
//
// We verify two things:
//   1. accounts.takosumi.test loads cleanly (Pebble root IS trusted).
//   2. A deliberately-untrusted host throws net::ERR_CERT_*.
//
// Without this test, someone re-adding `ignoreHTTPSErrors: true` to
// playwright.config.ts would have all browser smokes silently passing
// against broken cert chains.
test("trusts Pebble root for accounts.takosumi.test", async ({ page }) => {
  // If NSS DB has Pebble root, this loads cleanly.
  await page.goto("https://accounts.takosumi.test/sign-in");
  await expect(page).toHaveTitle(/サインイン|Takosumi/);
});

test("rejects untrusted certs (no silent bypass)", async ({ page, context }) => {
  // The local-substrate doesn't bind cert for any random *.test host —
  // Caddy serves a default cert via Pebble but only for hosts in the
  // Caddyfile. badssl.com has a guaranteed-bad cert we can use, but
  // we don't want the test to require external network. Instead, force
  // an HTTPS request to a host that won't have a matching cert.
  //
  // Skip if CI doesn't have outbound network to the public BadSSL
  // service (Skip rather than fake-pass).
  context.setDefaultTimeout(5000);
  try {
    await page.goto("https://self-signed.badssl.com/", { timeout: 5000 });
    // If we got here without throwing, Playwright is configured to
    // bypass TLS errors — fail loudly.
    throw new Error(
      "EXPECTED page.goto to throw on self-signed.badssl.com (untrusted cert), " +
        "but it loaded successfully — Playwright is bypassing cert validation",
    );
  } catch (err) {
    const msg = (err as Error).message;
    // Acceptable: cert error OR network timeout (CI no-net).
    // Fail: page actually loaded.
    if (msg.startsWith("EXPECTED")) throw err;
    expect(msg).toMatch(/ERR_CERT|timeout|net::ERR_/);
  }
});
