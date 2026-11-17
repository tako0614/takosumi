#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const ENCRYPTED_STATE_NATIVE_TEST =
  "./tests/native/node-postgres/encrypted-state-update-reconstruction_test.ts";

export function encryptedStateNativeCommand(input: {
  readonly bun: string;
  readonly tofu: string | null;
  readonly tar: string | null;
  readonly zstd: string | null;
}): readonly string[] {
  for (const name of ["bun", "tofu", "tar", "zstd"] as const) {
    if (!input[name])
      throw new Error(
        `encrypted-state native prerequisite unavailable: ${name}`,
      );
  }
  return [input.bun, "--no-env-file", "test", ENCRYPTED_STATE_NATIVE_TEST];
}

export function encryptedStateNativeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  // Only the outer test may create the private, allowlisted inner child.
  return { ...environment, TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD: "0" };
}

const MAX_NATIVE_CHILD_OUTPUT_BYTES = 64 * 1024;

export async function captureEncryptedStateNativeOutput(
  stream: ReadableStream<Uint8Array>,
  raw: Uint8Array[],
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return output + decoder.decode();
      const remaining = MAX_NATIVE_CHILD_OUTPUT_BYTES - bytes;
      if (remaining > 0) raw.push(chunk.value.slice(0, remaining));
      bytes += chunk.value.byteLength;
      if (bytes > MAX_NATIVE_CHILD_OUTPUT_BYTES)
        throw new Error("native test child output exceeded bound");
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Failure diagnostics never replace the child/capture failure or overwrite custody. */
export async function writeEncryptedStateNativeDiagnostics(
  root: string,
  raw: {
    readonly stdout: readonly Uint8Array[];
    readonly stderr: readonly Uint8Array[];
  },
  report: (message: string) => void = (message) => console.error(message),
): Promise<void> {
  const reportSafely = (message: string) => {
    try {
      report(message);
    } catch {
      /* Original failure wins. */
    }
  };
  try {
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      throw new Error("native diagnostic root is not private and owned");
    }
    for (const [name, chunks] of [
      ["stdout", raw.stdout],
      ["stderr", raw.stderr],
    ] as const) {
      try {
        const file = await open(
          join(root, `child.${name}.log`),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(
            Buffer.concat(chunks).subarray(0, MAX_NATIVE_CHILD_OUTPUT_BYTES),
          );
        } finally {
          await file.close();
        }
      } catch {
        reportSafely(
          `native child ${name} diagnostic unavailable; original failure retained`,
        );
      }
    }
  } catch {
    reportSafely(
      "native child diagnostics unavailable; original failure retained",
    );
  }
}

if (import.meta.main) {
  try {
    const command = encryptedStateNativeCommand({
      bun: process.execPath,
      tofu: Bun.which("tofu"),
      tar: Bun.which("tar"),
      zstd: Bun.which("zstd"),
    });
    const child = Bun.spawn([...command], {
      cwd: resolve(import.meta.dir, ".."),
      env: encryptedStateNativeEnvironment(process.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await child.exited);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "encrypted-state native gate failed",
    );
    process.exit(1);
  }
}
