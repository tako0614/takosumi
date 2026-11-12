import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitCurlRuntime } from "../../runner/lib/git_curl_runtime.ts";
import { baseCommandEnv } from "../../runner/lib/credentials.ts";

async function fixture(input: { execPath?: string; linkage?: string; hang?: boolean }): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "git-curl-runtime-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const invalidLibrary = join(root, "not-a-native-library");
    await writeFile(invalidLibrary, "fixture: unavailable native library\n");
    await writeFile(join(bin, "git"), input.hang ? "#!/bin/sh\nexec /usr/bin/sleep 5\n" :
      `#!/bin/sh\nprintf '%s\\n' '${input.execPath ?? root}'\n`);
    await writeFile(join(bin, "ldd"), `#!/bin/sh\nprintf '%s\\n' '${input.linkage ?? `libcurl.so.4 => ${invalidLibrary} (0x1234)`}'\n`);
    await chmod(join(bin, "git"), 0o700);
    await chmod(join(bin, "ldd"), 0o700);
    return await readGitCurlRuntime({ env: { PATH: bin, HOME: root }, timeoutMs: input.hang ? 20 : 5_000 }, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("actual local Git-linked curl runtime is inspected without a remote operation", async () => {
  const result = await readGitCurlRuntime({ env: baseCommandEnv() }, process.cwd());
  expect(result).toMatchObject({ versionNumber: expect.any(Number), ipv6: expect.any(Boolean) });
});

test.each([
  { execPath: "relative-helper" },
  { linkage: "statically linked" },
  { linkage: "libcurl.so.4 => not found" },
  { linkage: "libcurl.so.4 => /first (0x1234)\nlibcurl-gnutls.so.4 => /second (0x2345)" },
  {},
  { hang: true },
])("unknown, ambiguous, unavailable or timed-out native inspection refuses: %j", async input => {
  expect(await fixture(input)).toBeNull();
});
