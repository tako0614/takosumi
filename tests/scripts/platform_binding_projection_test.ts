import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PLATFORM_BINDINGS,
  platformBindingNames,
} from "../../deploy/accounts-cloudflare/src/bindings-check.ts";
import {
  checkPlatformBindingProjection,
  localSubstrateBindings,
  ossTemplateBindings,
} from "../../scripts/check-platform-bindings.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ossTemplate = readFileSync(
  resolve(ROOT, "deploy/platform/wrangler.toml"),
  "utf8",
);
const localSubstrate = readFileSync(
  resolve(
    ROOT,
    "deploy/local-substrate/wrappers/takosumi-platform-worker-runner.mjs",
  ),
  "utf8",
);

test("every artifact matches the one binding declaration", () => {
  expect(checkPlatformBindingProjection({ ossTemplate, localSubstrate })).toEqual(
    [],
  );
});

test("the projection can fail in both directions", () => {
  // A declared binding dropped from an artifact.
  const withoutBackups = ossTemplate.replace(
    'binding = "R2_BACKUPS"',
    'binding = "R2_SOMETHING_ELSE"',
  );
  const dropped = checkPlatformBindingProjection({
    ossTemplate: withoutBackups,
    localSubstrate,
  });
  expect(dropped.some((line) => line.includes("is missing R2_BACKUPS"))).toBe(
    true,
  );
  // A binding an artifact carries that nothing declares. This is the shape of
  // the fifth R2 bucket the operator's realized configs bind: it existed in no
  // required list, no template and no runner, so nothing could say whether it
  // was wanted.
  expect(
    dropped.some((line) =>
      line.includes("the binding table does not declare at all"),
    ),
  ).toBe(true);

  // A binding declared for no artifact must stay out of every artifact.
  const withExports = ossTemplate.replace(
    'binding = "R2_BACKUPS"',
    'binding = "TAKOSUMI_ACCOUNTS_EXPORTS"',
  );
  expect(
    checkPlatformBindingProjection({
      ossTemplate: withExports,
      localSubstrate,
    }).some((line) => line.includes("which is declared for no artifact")),
  ).toBe(true);

  const withoutRunner = localSubstrate.replace(
    "  RUNNER: {",
    "  RUNNER_RENAMED: {",
  );
  expect(
    checkPlatformBindingProjection({
      ossTemplate,
      localSubstrate: withoutRunner,
    }).some((line) => line.includes("is missing RUNNER")),
  ).toBe(true);
});

test("the readiness list is a projection of the table, not a second copy", () => {
  const readiness = new Set(platformBindingNames("readiness"));
  for (const [name, declaration] of Object.entries(PLATFORM_BINDINGS)) {
    expect(readiness.has(name)).toBe(declaration.lists.includes("readiness"));
  }
  // Every readiness binding is one the shipped template can actually provide.
  for (const name of readiness) {
    expect(ossTemplateBindings(ossTemplate)).toContain(name);
  }
});

test("the local substrate parser reads the runner's real configuration", () => {
  const found = localSubstrateBindings(localSubstrate);
  expect(found.length).toBeGreaterThan(0);
  expect(found).toContain("TAKOSUMI_CONTROL_DB");
  expect(found).toContain("R2_BACKUPS");
  expect(found).toContain("RUN_OWNER");
});
