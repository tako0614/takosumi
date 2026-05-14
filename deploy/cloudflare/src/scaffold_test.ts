import assert from "node:assert/strict";

const cloudflareRoot = new URL("../", import.meta.url);

Deno.test("Cloudflare scaffold is Worker-only and keeps D1/R2 bindings", async () => {
  const wrangler = await Deno.readTextFile(
    new URL("wrangler.toml", cloudflareRoot),
  );

  assert.doesNotMatch(wrangler, /\[\[containers\]\]/);
  assert.doesNotMatch(wrangler, /TAKOS_WORKLOAD_CONTAINER/);
  assert.doesNotMatch(wrangler, /TAKOS_KERNEL_CONTAINER/);
  assert.match(wrangler, /no_bundle = true/);
  assert.match(wrangler, /deno bundle/);
  assert.match(wrangler, /binding = "TAKOS_D1"/);
  assert.match(wrangler, /binding = "TAKOS_ARTIFACTS"/);
  assert.match(wrangler, /name = "TAKOS_COORDINATION"/);
  assert.match(
    wrangler,
    /new_sqlite_classes = \["TakosCoordinationObject"\]/,
  );
});

Deno.test("Cloudflare scaffold docs describe Worker-first D1/R2 routing", async () => {
  const readme = await Deno.readTextFile(
    new URL("README.md", cloudflareRoot),
  );

  assert.match(readme, /Worker-first/);
  assert.match(readme, /\/v1\/\*/);
  assert.match(readme, /\/api\/internal\/v1\/\*/);
  assert.match(readme, /D1/);
  assert.match(readme, /R2/);
  assert.doesNotMatch(readme, /Cloudflare Container/);
});
