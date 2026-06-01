import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fetchPreparedSource } from "./prepared-source.ts";

const execFileAsync = promisify(execFile);

test("fetchPreparedSource verifies sha256 and extracts tar snapshot", async () => {
  const sourceDir = await makeTempDir("takosumi-prepared-source-src-");
  const archive = await makeTempFile("takosumi-prepared-source-", ".tar");
  try {
    await writeFile(`${sourceDir}/package.json`, '{"name":"app"}\n');
    await mkdir(`${sourceDir}/src`);
    await writeFile(
      `${sourceDir}/src/worker.mjs`,
      "export default {}",
    );
    await tar(["-c", "-f", archive, "-C", sourceDir, "package.json", "src"]);
    const bytes = await readFile(archive);
    const digest = await sha256Hex(bytes);

    const url = "https://example.test/prepared-source.tar";
    await withFetchStub(url, bytes, async () => {
      const result = await fetchPreparedSource({ url, digest });
      try {
        assert.equal(result.digest, digest);
        assert.equal(
          await readText(`${result.workingDirectory}/package.json`),
          '{"name":"app"}\n',
        );
        assert.equal(
          await readText(`${result.workingDirectory}/src/worker.mjs`),
          "export default {}",
        );
      } finally {
        await result.cleanup();
      }
    });
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dirname(archive), { recursive: true, force: true });
  }
});

test("fetchPreparedSource rejects digest mismatch", async () => {
  const url = "https://example.test/bad-prepared-source.tar";
  await withFetchStub(url, new TextEncoder().encode("not a tar"), async () => {
    await assert.rejects(
      fetchPreparedSource({
        url,
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
      /digest mismatch/,
    );
  });
});

test("fetchPreparedSource rejects file:// URLs", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "file:///tmp/anything.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

test("fetchPreparedSource rejects raw filesystem paths", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "/tmp/anything.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

test("fetchPreparedSource rejects http:// URLs", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "http://example.test/x.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

test("fetchPreparedSource accepts regular file whose name literally contains ' -> '", async () => {
  // Regression: a regular file literally named `evil -> target` used to be
  // truncated to `evil` by extractTarEntryPath, which both lost duplicate /
  // traversal detection coverage on the real path and could trick the
  // duplicate set into accepting two distinct archive entries that resolved
  // to the same on-disk file. The fix only applies ` -> ` truncation to
  // entries whose tar type byte is `l` (symlink) or `h` (hardlink), so this
  // archive should now extract cleanly with the literal filename intact.
  const sourceDir = await makeTempDir("takosumi-prepared-source-trick-src-");
  const archive = await makeTempFile("takosumi-prepared-source-trick-", ".tar");
  try {
    await writeFile(`${sourceDir}/package.json`, '{"name":"app"}\n');
    // Regular file literally named `evil -> target`.
    await writeFile(`${sourceDir}/evil -> target`, "regular file\n");
    await tar([
      "-c",
      "-f",
      archive,
      "-C",
      sourceDir,
      "package.json",
      "evil -> target",
    ]);
    const bytes = await readFile(archive);
    const digest = await sha256Hex(bytes);

    const url = "https://example.test/prepared-source-trick.tar";
    await withFetchStub(url, bytes, async () => {
      const result = await fetchPreparedSource({ url, digest });
      try {
        // The literal filename must survive end-to-end — neither the listing
        // parser nor the extraction can re-interpret it as a symlink.
        assert.equal(
          await readText(
            `${result.workingDirectory}/evil -> target`,
          ),
          "regular file\n",
        );
      } finally {
        await result.cleanup();
      }
    });
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dirname(archive), { recursive: true, force: true });
  }
});

test("fetchPreparedSource rejects oversized prepared archive by Content-Length", async () => {
  const url = "https://example.test/too-big.tar";
  const cap = 50 * 1024 * 1024; // matches the default cap
  const original = globalThis.fetch;
  globalThis.fetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response(new Uint8Array(8), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(cap + 1),
        },
      }),
    );
  };
  try {
    await assert.rejects(
      fetchPreparedSource({
        url,
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
      /archive_too_large/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPreparedSource rejects oversized prepared archive by actual byte length", async () => {
  // Use the env var to lower the cap so the test can produce a real
  // payload that exceeds it without allocating tens of megabytes.
  const previous = process.env["TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES"];
  process.env["TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES"] = "1024";
  const url = "https://example.test/too-big-body.tar";
  const oversized = new Uint8Array(2048);
  try {
    await withFetchStub(url, oversized, async () => {
      await assert.rejects(
        fetchPreparedSource({
          url,
          digest:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        }),
        /archive_too_large/,
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env["TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES"];
    } else {
      process.env["TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES"] = previous;
    }
  }
});

test("fetchPreparedSource rejects loopback / metadata host literals before fetch", async () => {
  // No fetch stub installed: if the host guard fails open, the real fetch
  // would be attempted. The guard must reject first.
  for (
    const url of [
      "https://127.0.0.1/x.tar",
      "https://[::1]/x.tar",
      "https://169.254.169.254/x.tar",
      "https://[64:ff9b::a9fe:a9fe]/x.tar",
    ]
  ) {
    await assert.rejects(
      fetchPreparedSource({
        url,
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
      /unsupported_source_url/,
    );
  }
});

test("fetchPreparedSource rejects redirect responses (SSRF-via-redirect)", async () => {
  const url = "https://example.test/redirecting.tar";
  const original = globalThis.fetch;
  let manualRedirectRequested = false;
  globalThis.fetch = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    manualRedirectRequested = init?.redirect === "manual";
    // Simulate a server that 302s toward an internal host.
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/" },
      }),
    );
  };
  try {
    await assert.rejects(
      fetchPreparedSource({
        url,
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
      /must not redirect/,
    );
    assert.ok(
      manualRedirectRequested,
      "fetch must be called with redirect: manual",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPreparedSource rejects a gzip bomb by decompressed size", async () => {
  // Build a tar of a single large sparse-ish file, gzip it (high ratio), and
  // lower the decompressed cap so the listing-sum guard trips before extract.
  const sourceDir = await makeTempDir("takosumi-prepared-source-bomb-src-");
  const archive = await makeTempFile("takosumi-prepared-source-bomb-", ".tar.gz");
  const previous = process.env["TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES"];
  process.env["TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES"] = "1024";
  try {
    await writeFile(`${sourceDir}/package.json`, '{"name":"app"}\n');
    // 1 MiB of highly compressible zeros -> tiny gzip, large decompressed.
    await writeFile(`${sourceDir}/big`, new Uint8Array(1024 * 1024));
    await tar([
      "-c",
      "-z",
      "-f",
      archive,
      "-C",
      sourceDir,
      "package.json",
      "big",
    ]);
    const bytes = await readFile(archive);
    const digest = await sha256Hex(bytes);
    const url = "https://example.test/bomb.tar.gz";
    await withFetchStub(url, bytes, async () => {
      await assert.rejects(
        fetchPreparedSource({ url, digest }),
        /archive_too_large/,
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env["TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES"];
    } else {
      process.env["TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES"] = previous;
    }
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dirname(archive), { recursive: true, force: true });
  }
});

test("fetchPreparedSource rejects symlink whose filename contains ' -> ' and escapes", async () => {
  // Regression: a symlink named `a -> b` pointing at `../../../etc/evil`
  // produces the tar -tv line `... a -> b -> ../../../etc/evil`. The old
  // split(" -> ")[1] validated the fragment `b` (which passes) instead of the
  // real escaping target, letting it through. The unified parser must cut at
  // the FIRST separator and validate the real remainder.
  const sourceDir = await makeTempDir("takosumi-prepared-source-symlink-src-");
  const archive = await makeTempFile("takosumi-prepared-source-symlink-", ".tar");
  try {
    await writeFile(`${sourceDir}/package.json`, '{"name":"app"}\n');
    await symlink("../../../etc/evil", `${sourceDir}/a -> b`);
    await tar([
      "-c",
      "-f",
      archive,
      "-C",
      sourceDir,
      "package.json",
      "a -> b",
    ]);
    const bytes = await readFile(archive);
    const digest = await sha256Hex(bytes);
    const url = "https://example.test/symlink-trick.tar";
    await withFetchStub(url, bytes, async () => {
      await assert.rejects(
        fetchPreparedSource({ url, digest }),
        /link target escapes destination/,
      );
    });
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dirname(archive), { recursive: true, force: true });
  }
});

async function tar(args: readonly string[]): Promise<void> {
  await execFileAsync("tar", [...args]);
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function makeTempFile(prefix: string, suffix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  return join(dir, `archive${suffix}`);
}

async function readText(path: URL | string): Promise<string> {
  return readFile(path, "utf8");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

/**
 * Replace globalThis.fetch with a stub that returns `bytes` for `url`.
 * Other URLs fall through to the real fetch (which the test suite does
 * not exercise here) so unexpected calls fail loudly.
 */
async function withFetchStub(
  url: string,
  bytes: Uint8Array,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const target = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (target === url) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return Promise.resolve(
        new Response(copy, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }
    return Promise.reject(
      new Error(`unexpected fetch in prepared-source test: ${target}`),
    );
  };
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}
