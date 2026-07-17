import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTakoformPackageArtifactReader } from "../../../deploy/node-postgres/src/takoform-package-composition.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("private-file package reader confines regular immutable artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-takoform-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "package.json"), "package");
  const reader = new FileTakoformPackageArtifactReader(root);

  expect(new TextDecoder().decode(await reader.read("file:package.json"))).toBe(
    "package",
  );
  await expect(reader.read("r2:package.json")).rejects.toThrow("file:");
  await expect(reader.read("file:../package.json")).rejects.toThrow(
    "canonical relative path",
  );
});

test("private-file package reader rejects symlink traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-takoform-"));
  temporaryRoots.push(root);
  await writeFile(join(root, "target.json"), "package");
  await symlink("target.json", join(root, "link.json"));
  const reader = new FileTakoformPackageArtifactReader(root);

  await expect(reader.read("file:link.json")).rejects.toThrow("symbolic link");
});
