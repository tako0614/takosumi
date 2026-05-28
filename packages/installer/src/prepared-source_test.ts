import assert from "node:assert/strict";
import { fetchPreparedSource } from "./prepared-source.ts";

Deno.test("fetchPreparedSource verifies sha256 and extracts tar snapshot", async () => {
  const sourceDir = await Deno.makeTempDir({
    prefix: "takosumi-prepared-source-src-",
  });
  const archive = await Deno.makeTempFile({
    prefix: "takosumi-prepared-source-",
    suffix: ".tar",
  });
  try {
    await Deno.writeTextFile(`${sourceDir}/.takosumi.yml`, "apiVersion: v1\n");
    await Deno.mkdir(`${sourceDir}/src`);
    await Deno.writeTextFile(
      `${sourceDir}/src/worker.mjs`,
      "export default {}",
    );
    await tar(["-c", "-f", archive, "-C", sourceDir, ".takosumi.yml", "src"]);
    const bytes = await Deno.readFile(archive);
    const digest = await sha256Hex(bytes);

    const url = "https://example.test/prepared-source.tar";
    await withFetchStub(url, bytes, async () => {
      const result = await fetchPreparedSource({ url, digest });
      try {
        assert.equal(result.digest, digest);
        assert.equal(
          await Deno.readTextFile(`${result.workingDirectory}/.takosumi.yml`),
          "apiVersion: v1\n",
        );
        assert.equal(
          await Deno.readTextFile(`${result.workingDirectory}/src/worker.mjs`),
          "export default {}",
        );
      } finally {
        await result.cleanup();
      }
    });
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
    await Deno.remove(archive);
  }
});

Deno.test("fetchPreparedSource rejects digest mismatch", async () => {
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

Deno.test("fetchPreparedSource rejects file:// URLs", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "file:///tmp/anything.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

Deno.test("fetchPreparedSource rejects raw filesystem paths", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "/tmp/anything.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

Deno.test("fetchPreparedSource rejects http:// URLs", async () => {
  await assert.rejects(
    fetchPreparedSource({
      url: "http://example.test/x.tar",
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
    /unsupported_source_url/,
  );
});

Deno.test("fetchPreparedSource accepts regular file whose name literally contains ' -> '", async () => {
  // Regression: a regular file literally named `evil -> target` used to be
  // truncated to `evil` by extractTarEntryPath, which both lost duplicate /
  // traversal detection coverage on the real path and could trick the
  // duplicate set into accepting two distinct archive entries that resolved
  // to the same on-disk file. The fix only applies ` -> ` truncation to
  // entries whose tar type byte is `l` (symlink) or `h` (hardlink), so this
  // archive should now extract cleanly with the literal filename intact.
  const sourceDir = await Deno.makeTempDir({
    prefix: "takosumi-prepared-source-trick-src-",
  });
  const archive = await Deno.makeTempFile({
    prefix: "takosumi-prepared-source-trick-",
    suffix: ".tar",
  });
  try {
    await Deno.writeTextFile(`${sourceDir}/.takosumi.yml`, "apiVersion: v1\n");
    // Regular file literally named `evil -> target`.
    await Deno.writeTextFile(`${sourceDir}/evil -> target`, "regular file\n");
    await tar([
      "-c",
      "-f",
      archive,
      "-C",
      sourceDir,
      ".takosumi.yml",
      "evil -> target",
    ]);
    const bytes = await Deno.readFile(archive);
    const digest = await sha256Hex(bytes);

    const url = "https://example.test/prepared-source-trick.tar";
    await withFetchStub(url, bytes, async () => {
      const result = await fetchPreparedSource({ url, digest });
      try {
        // The literal filename must survive end-to-end — neither the listing
        // parser nor the extraction can re-interpret it as a symlink.
        assert.equal(
          await Deno.readTextFile(
            `${result.workingDirectory}/evil -> target`,
          ),
          "regular file\n",
        );
      } finally {
        await result.cleanup();
      }
    });
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
    await Deno.remove(archive);
  }
});

Deno.test("fetchPreparedSource rejects oversized prepared archive by Content-Length", async () => {
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

Deno.test("fetchPreparedSource rejects oversized prepared archive by actual byte length", async () => {
  // Use the env var to lower the cap so the test can produce a real
  // payload that exceeds it without allocating tens of megabytes.
  const previous = Deno.env.get("TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES");
  Deno.env.set("TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES", "1024");
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
      Deno.env.delete("TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES");
    } else {
      Deno.env.set("TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES", previous);
    }
  }
});

async function tar(args: readonly string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("tar", {
    args: [...args],
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(new TextDecoder().decode(stderr));
  }
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
