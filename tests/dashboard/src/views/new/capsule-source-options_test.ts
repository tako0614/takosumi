import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");

test("CapsuleSourceOptions chooser is folded into /new", async () => {
  const source = await readFile(
    resolve(root, "dashboard/src/views/new/InstallView.tsx"),
    "utf8",
  );
  expect(source).toContain("parseCapsuleSourceOptionsText(file.text)");
  // Provenance — pin an absent ref to the newest stable SemVer tag, then prove
  // the snapshot came back on that exact commit — now lives in the shared
  // reader both snapshot pickers use. The chooser records the commit it got.
  expect(source).toContain("readSnapshotDocument({");
  expect(source).toContain("resolveStableSourceTag(");
  const reader = await readFile(
    resolve(root, "dashboard/src/lib/snapshot-document.ts"),
    "utf8",
  );
  expect(reader).toContain("resolveStableSourceTag(");
  expect(reader).toContain("snapshot.resolvedCommit !== resolved.commit");
  expect(source).toContain('setPhase("entry")');
  expect(source).toContain("chooseEntry");
  expect(source).toContain("createCapsule(");
  expect(source).toContain("planCapsule(");
});

test("/install preserves ordinary and options links on the one /new route", async () => {
  const source = await readFile(
    resolve(root, "dashboard/src/index.tsx"),
    "utf8",
  );
  expect(source).not.toContain("CapsuleSourceOptionsInstallView");
  expect(source).toContain("<Navigate href={`/new${location.search}`} />");
  expect(source).toContain(
    '<Route path="/install" component={InstallEntryRoute} />',
  );
});
