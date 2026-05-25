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
    const digest = await sha256Hex(await Deno.readFile(archive));

    const result = await fetchPreparedSource({ url: archive, digest });
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
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
    await Deno.remove(archive);
  }
});

Deno.test("fetchPreparedSource rejects digest mismatch", async () => {
  const archive = await Deno.makeTempFile({
    prefix: "takosumi-prepared-source-",
    suffix: ".tar",
  });
  try {
    await Deno.writeFile(archive, new TextEncoder().encode("not a tar"));
    await assert.rejects(
      fetchPreparedSource({
        url: archive,
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
      /digest mismatch/,
    );
  } finally {
    await Deno.remove(archive);
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
