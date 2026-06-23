import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);
const SCRIPT = new URL("scripts/smoke-cloudflare.ts", ROOT);

test("Cloudflare smoke plans first and applies the saved plan", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const planIndex = source.indexOf('["plan", "-no-color", "-input=false"');
  const applyIndex = source.indexOf(
    '["apply", "-no-color", "-input=false", PLAN_FILE]',
  );

  assert.ok(planIndex > 0, "smoke must run tofu plan");
  assert.ok(applyIndex > planIndex, "smoke must apply after planning");
  assert.match(source, /`-out=\$\{PLAN_FILE\}`/);
  assert.equal(
    source.includes(
      '["apply", "-no-color", "-input=false", "-auto-approve", ...vars]',
    ),
    false,
    "smoke must not apply directly with -auto-approve and vars",
  );
});
