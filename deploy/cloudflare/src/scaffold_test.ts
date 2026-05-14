import assert from "node:assert/strict";

const cloudflareRoot = new URL("../", import.meta.url);

Deno.test("Cloudflare scaffold keeps container bindings in sync", async () => {
  const wrangler = await Deno.readTextFile(
    new URL("wrangler.toml", cloudflareRoot),
  );

  assert.match(wrangler, /name = "TAKOS_WORKLOAD_CONTAINER"/);
  assert.match(wrangler, /name = "TAKOS_KERNEL_CONTAINER"/);
  assert.match(wrangler, /class_name = "TakosWorkloadContainer"/);
  assert.match(wrangler, /\[\[containers\]\]/);
  assert.match(
    wrangler,
    /new_sqlite_classes = \["TakosCoordinationObject", "TakosWorkloadContainer"\]/,
  );
});

Deno.test("Cloudflare scaffold docs describe Worker-front and kernel-container routing", async () => {
  const readme = await Deno.readTextFile(
    new URL("README.md", cloudflareRoot),
  );

  assert.match(readme, /kernel control-plane/);
  assert.match(readme, /\/v1\/\*/);
  assert.match(readme, /\/api\/internal\/v1\/\*/);
  assert.match(readme, /\/healthz/);
  assert.match(readme, /\/coordination\/\*/);
  assert.match(readme, /\/storage\/healthz/);
  assert.match(readme, /Cloudflare Container/);
});
