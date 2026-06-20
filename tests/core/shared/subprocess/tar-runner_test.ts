/**
 * Unit tests for the shared low-level `tar` subprocess primitive.
 *
 * `runTarCommand` shells out to the host `tar` binary (a local CLI, always
 * present on the runner image and on any POSIX dev box), so these tests build a
 * real tar archive in-process and round-trip it through the primitive. No
 * network or container dependency.
 */

import { test, expect } from "bun:test";
import { runTarCommand } from "../../../../core/shared/subprocess/tar-runner.ts";

/**
 * Build a minimal but valid USTAR archive containing a single regular file so
 * the test does not depend on a second `tar` invocation to produce its input.
 */
function buildSingleFileTar(name: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const block = 512;
  const header = new Uint8Array(block);

  const writeField = (offset: number, length: number, value: string) => {
    const bytes = enc.encode(value);
    header.set(bytes.subarray(0, length), offset);
  };

  // name (100), mode (8), uid (8), gid (8), size (12), mtime (12) ...
  writeField(0, 100, name);
  writeField(100, 8, "0000644\0");
  writeField(108, 8, "0000000\0");
  writeField(116, 8, "0000000\0");
  const bodyBytes = enc.encode(body);
  writeField(124, 12, bodyBytes.length.toString(8).padStart(11, "0") + "\0");
  writeField(136, 12, "00000000000\0");
  // typeflag '0' = regular file
  header[156] = "0".charCodeAt(0);
  // magic + version for USTAR
  writeField(257, 6, "ustar\0");
  writeField(263, 2, "00");

  // checksum: blanks while summing, then octal back into the field.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < block; i++) sum += header[i];
  writeField(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");

  // file body padded to a 512 block, then two zero blocks as end-of-archive.
  const bodyBlocks = Math.ceil(bodyBytes.length / block) * block;
  const out = new Uint8Array(block + bodyBlocks + block * 2);
  out.set(header, 0);
  out.set(bodyBytes, block);
  return out;
}

test("runTarCommand lists the entries of a valid archive on stdout", async () => {
  const archive = buildSingleFileTar("greeting.txt", "hello takosumi\n");

  const stdout = await runTarCommand(["-tf", "-"], archive);

  expect(stdout).toContain("greeting.txt");
});

test("runTarCommand resolves stdout for an empty (end-of-archive only) tar", async () => {
  // Two zero blocks is a well-formed empty archive; listing yields no entries.
  const emptyArchive = new Uint8Array(512 * 2);

  const stdout = await runTarCommand(["-tf", "-"], emptyArchive);

  expect(stdout.trim()).toBe("");
});

test("runTarCommand rejects with the failing command in the message on non-zero exit", async () => {
  const garbage = new TextEncoder().encode("this is definitely not a tar archive");

  let thrown: unknown;
  try {
    await runTarCommand(["-tf", "-"], garbage);
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(Error);
  // Message shape is `tar <args> failed: <stderr>`; assert both the prefix
  // (joined args) and that captured stderr is surfaced, not swallowed.
  const message = (thrown as Error).message;
  expect(message).toContain("tar -tf - failed:");
  expect(message.length).toBeGreaterThan("tar -tf - failed:".length);
});

test("runTarCommand surfaces a spawn failure as a rejected promise", async () => {
  // An unknown subcommand makes `tar` exit non-zero with a diagnostic; the
  // primitive must reject rather than resolve with partial stdout.
  const archive = buildSingleFileTar("x.txt", "x");

  let thrown: unknown;
  try {
    await runTarCommand(["--this-flag-does-not-exist"], archive);
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(Error);
});
