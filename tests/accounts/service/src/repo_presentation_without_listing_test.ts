/**
 * A repository that declares its own name / description / icon must present
 * that identity whether the user arrived from a catalog listing or pasted the
 * Git URL. The presentation used to be discarded outright when no listing
 * existed, so a correct app looked anonymous purely because of how it was
 * reached.
 */
import { expect, test } from "bun:test";

import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  hydrateRepoOwnedStoreConfig,
  neutralInstallPresentation,
} from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";

const NOW = "2026-08-23T00:00:00.000Z";
const GIT_URL = "https://git.example.test/notes-app.git";

const source: Source = {
  id: "src_notes",
  workspaceId: "ws_notes",
  name: "notes",
  url: GIT_URL,
  defaultRef: "main",
  defaultPath: ".",
  status: "active",
  autoSync: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const sourceSnapshot: SourceSnapshot = {
  id: "snap_notes",
  origin: "git",
  workspaceId: source.workspaceId,
  sourceId: source.id,
  url: source.url,
  ref: "main",
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  path: ".",
  archiveRef: "test://notes.tar.zst",
  archiveDigest: `sha256:${"a".repeat(64)}`,
  archiveSizeBytes: 1,
  fetchedByRunId: "run_notes_sync",
  fetchedAt: NOW,
};

/** The repository's own `.well-known` presentation document. */
const REPO_METADATA = {
  schemaVersion: "tcs.repo/v1",
  name: { ja: "メモ帳", en: "Notes" },
  description: { ja: "自分のメモを置く場所。", en: "Somewhere to keep notes." },
  iconUrl: "https://cdn.example.test/notes.png",
};

function operationsReturning(
  metadata: unknown,
): ControlPlaneOperations {
  return {
    readSourceSnapshotFiles: async () => [
      {
        path: ".well-known/tcs.json",
        text: JSON.stringify(metadata),
      },
    ],
  } as unknown as ControlPlaneOperations;
}

test("a Git-URL install keeps the repository's declared identity", async () => {
  const result = await hydrateRepoOwnedStoreConfig({
    operations: operationsReturning(REPO_METADATA),
    source,
    sourceSnapshot,
    // No catalog listing selected this install.
    storeMetadata: undefined,
    modulePath: ".",
    presentationFallback: neutralInstallPresentation({
      gitUrl: GIT_URL,
      capsuleName: "notes",
    }),
  });

  expect(result.storeMetadata?.name).toEqual({ ja: "メモ帳", en: "Notes" });
  expect(result.storeMetadata?.description).toEqual({
    ja: "自分のメモを置く場所。",
    en: "Somewhere to keep notes.",
  });
  expect(result.storeMetadata?.iconUrl).toBe(
    "https://cdn.example.test/notes.png",
  );
  // The source stays the repository the user actually pasted.
  expect(result.storeMetadata?.source?.url).toBe(GIT_URL);
});

test("without a fallback base the repository presentation is still dropped", async () => {
  const result = await hydrateRepoOwnedStoreConfig({
    operations: operationsReturning(REPO_METADATA),
    source,
    sourceSnapshot,
    storeMetadata: undefined,
    modulePath: ".",
  });
  // Callers that genuinely have no presentation surface (internal flows) keep
  // the previous behavior rather than inventing one.
  expect(result.storeMetadata).toBeUndefined();
});

test("a repository with no presentation document falls back to its Capsule name", async () => {
  const result = await hydrateRepoOwnedStoreConfig({
    operations: operationsReturning({ schemaVersion: "tcs.repo/v1" }),
    source,
    sourceSnapshot,
    storeMetadata: undefined,
    modulePath: ".",
    presentationFallback: neutralInstallPresentation({
      gitUrl: GIT_URL,
      capsuleName: "notes",
    }),
  });
  expect(result.storeMetadata?.name).toEqual({ ja: "notes", en: "notes" });
  expect(result.storeMetadata?.iconUrl).toBeUndefined();
});

test("the neutral base fills every field the store projection requires", () => {
  const base = neutralInstallPresentation({
    gitUrl: GIT_URL,
    capsuleName: "notes",
  });
  expect(base.suggestedName).toBe("notes");
  expect(base.source?.url).toBe(GIT_URL);
  for (const required of [
    "order",
    "surface",
    "kind",
    "provider",
    "badge",
    "name",
    "description",
  ] as const) {
    expect(base[required]).toBeDefined();
  }
});

test("an empty Capsule name still yields a usable suggested name", () => {
  expect(
    neutralInstallPresentation({ gitUrl: GIT_URL, capsuleName: "" })
      .suggestedName,
  ).toBe("service");
});
