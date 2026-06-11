import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "../../../test/assert.ts";
import {
  parseAppInstallationImportData,
  sha256HexBytes,
} from "./installation-helpers.ts";

const dumpText = "select 1;\n";
const dumpBase64 = btoa(dumpText);

async function dumpDigest(): Promise<string> {
  return await sha256HexBytes(new TextEncoder().encode(dumpText));
}

test("import data accepts an entry whose content matches the recorded digest", async () => {
  const contentDigest = await dumpDigest();
  const parsed = await parseAppInstallationImportData({
    manifest: {
      kind: "takosumi.accounts.installation-export-data-manifest@v1",
      version: "v1",
      files: [{
        path: "takos-export/data/postgres/dump.sql",
        mediaType: "application/sql",
        byteLength: dumpText.length,
        contentDigest,
      }],
    },
    entries: [{
      path: "takos-export/data/postgres/dump.sql",
      mediaType: "application/sql",
      byteLength: dumpText.length,
      contentDigest,
      contentBase64: dumpBase64,
    }],
  });

  expect(parsed?.entries.length).toEqual(1);
  expect(parsed?.entries[0].contentDigest).toEqual(contentDigest);
});

test("import data rejects a same-length entry whose content digest does not match", async () => {
  // Substituted payload of identical byteLength: byteLength alone passes, the
  // content digest must catch it.
  const tampered = "SELECT 2;\n"; // same length as "select 1;\n"
  expect(tampered.length).toEqual(dumpText.length);
  const declaredDigest = await dumpDigest();

  await assertRejects(
    () =>
      parseAppInstallationImportData({
        entries: [{
          path: "takos-export/data/postgres/dump.sql",
          byteLength: dumpText.length,
          contentDigest: declaredDigest,
          contentBase64: btoa(tampered),
        }],
      }),
    TypeError,
    "contentDigest mismatch",
  );
});

test("import data rejects a manifest file with no content digest", async () => {
  const contentDigest = await dumpDigest();
  await assertRejects(
    () =>
      parseAppInstallationImportData({
        entries: [{
          path: "takos-export/data/postgres/dump.sql",
          byteLength: dumpText.length,
          // contentDigest omitted
          contentBase64: dumpBase64,
        }],
      }),
    TypeError,
    "requires a sha256 contentDigest",
  );
  // Sanity: with the digest present the same entry parses.
  const parsed = await parseAppInstallationImportData({
    entries: [{
      path: "takos-export/data/postgres/dump.sql",
      byteLength: dumpText.length,
      contentDigest,
      contentBase64: dumpBase64,
    }],
  });
  expect(parsed?.entries.length).toEqual(1);
});
