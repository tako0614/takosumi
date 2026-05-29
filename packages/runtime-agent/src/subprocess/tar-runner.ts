/**
 * `tar` subprocess primitive for the runtime-agent prepared-source reader
 * (Deno implementation).
 *
 * Canonical Deno runtime path: invokes `tar` through `Deno.Command` exactly as
 * before, piping the archive bytes to stdin. The npm build swaps this module
 * for the Node sibling (`tar-runner.node.ts`) via a dnt `mappings` entry in
 * `scripts/build-npm.ts`. Keep the exported shape identical between the two.
 */

export async function runTarCommand(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  // Force a deterministic C locale so the `tar -tv` column format (mode, owner,
  // size, date, time, path) does not shift with the operator's LANG / LC_TIME
  // settings. Without this, locale-specific date / time columns can introduce
  // extra whitespace runs that confuse the column parser.
  const child = new Deno.Command("tar", {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      LC_ALL: "C",
      LANG: "C",
    },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(stdin);
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(
      `tar ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}
