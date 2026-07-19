import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");

test("CapsuleSourceOptions chooser only hands one selected source to /new", async () => {
  const source = await readFile(
    resolve(
      root,
      "dashboard/src/views/new/CapsuleSourceOptionsInstallView.tsx",
    ),
    "utf8",
  );
  expect(source).toContain("parseCapsuleSourceOptionsText(file.text)");
  expect(source).toContain("file.digest");
  expect(source).toContain("snapshot.resolvedCommit");
  expect(source).toContain("resolveStableSourceTag(workspaceId");
  expect(source).toContain("navigate(");
  expect(source).toContain("`/new${capsuleSourceOptionInstallSearch");
  expect(source).not.toContain("createCapsule(");
  expect(source).not.toContain("planCapsule(");
  expect(source).not.toContain("applyRun(");
});

test("/install preserves ordinary links and routes only the declared options kind to chooser", async () => {
  const source = await readFile(
    resolve(root, "dashboard/src/index.tsx"),
    "utf8",
  );
  expect(source).toContain(
    "hasCapsuleSourceOptionsInstallLink(location.search)",
  );
  expect(source).toContain("<Navigate href={`/new${location.search}`} />");
  expect(source).toContain(
    '<Route path="/install" component={InstallEntryRoute} />',
  );
});
