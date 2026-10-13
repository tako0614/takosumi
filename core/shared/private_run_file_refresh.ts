/** Internal Runner delivery only; never a public Host or Takoform contract. */
export const PRIVATE_RUN_FILE_REFRESH_CAPABILITY =
  "takosumi.runner-private-run-files-refresh@v1";
export const PRIVATE_RUN_FILE_REFRESH_PATH =
  "/runs/:runnerRunId/private-run-files";
export const PRIVATE_RUN_FILE_REFRESH_SEQUENCE_HEADER =
  "x-takosumi-private-run-files-sequence";
export const PRIVATE_RUN_FILE_DESCRIPTOR_ENV =
  "TAKOSUMI_PRIVATE_RUN_FILES_FILE";
export const MAX_PRIVATE_RUN_FILE_DISPATCHES = 256;
export const MAX_PRIVATE_RUN_FILE_DESCRIPTOR_BYTES = 4 * 1024 * 1024;
export const MAX_PRIVATE_RUN_FILE_ROTATIONS = 2_048;

export interface PrivateRunFileRefreshOwner {
  readonly kind: "plan" | "apply";
  readonly id: string;
}

export interface PrivateRunFileRefreshFile {
  readonly slot: string;
  readonly endpoint: string;
  readonly grant: string;
}

export interface PrivateRunFileRefreshUpdate {
  readonly kind: "takosumi.private-run-files.refresh@v1";
  readonly owner: PrivateRunFileRefreshOwner;
  readonly runnerRunId: string;
  /** Digest of stable slot/endpoint identity, never of rotating bearer grants. */
  readonly manifestDigest: string;
  /** Initial dispatch is zero; each accepted replacement increments by one. */
  readonly sequence: number;
  readonly files: readonly PrivateRunFileRefreshFile[];
}

export interface PrivateRunFileDescriptorFile {
  readonly version: 1;
  readonly sequence: number;
  readonly files: readonly PrivateRunFileRefreshFile[];
}

export async function privateRunFileManifestDigest(input: {
  readonly owner: PrivateRunFileRefreshOwner;
  readonly runnerRunId: string;
  readonly files: readonly PrivateRunFileRefreshFile[];
}): Promise<string> {
  const files = input.files.map(({ slot, endpoint }) => ({ slot, endpoint }))
    .sort((left, right) => left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0);
  const canonical = JSON.stringify({
    kind: "takosumi.private-run-files.manifest@v1",
    owner: { kind: input.owner.kind, id: input.owner.id },
    runnerRunId: input.runnerRunId,
    files,
  });
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  ));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
