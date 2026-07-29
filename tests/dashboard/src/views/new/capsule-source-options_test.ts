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
  // Provenance — pin an absent ref to the newest stable SemVer tag, then prove
  // the snapshot came back on that exact commit — now lives in the shared
  // reader both snapshot pickers use. The chooser records the commit it got.
  expect(source).toContain("readSnapshotDocument({");
  expect(source).toContain("commit,");
  expect(source).toContain("resolveStableSourceTag(workspaceId");
  const reader = await readFile(
    resolve(root, "dashboard/src/lib/snapshot-document.ts"),
    "utf8",
  );
  expect(reader).toContain("resolveStableSourceTag(");
  expect(reader).toContain("snapshot.resolvedCommit !== resolved.commit");
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
