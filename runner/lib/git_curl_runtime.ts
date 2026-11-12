// Probe the library loaded by Git's HTTPS helper, never a separate curl tool
// or Git's compile-time headers. Only operator-trusted local toolchain inputs
// reach this function; source credentials and repository files do not.
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CommandContext } from "./types.ts";
import { runCommand } from "./exec.ts";

// https://curl.se/libcurl/c/curl_version_info.html
// CURLVERSION_FIRST fields are ABI-stable. The offsets below are limited to
// Linux's 64-bit x64/arm64 ABI (32-bit int, 64-bit pointer); unknown ABIs refuse.
// Native inspection stays in a bounded child: an unavailable/failed FFI never
// crashes the Runner or qualifies the transport. No curl global init/network.
const READ_CURL_RUNTIME = `
  import {dlopen,read} from "bun:ffi";
  const library=dlopen(process.argv[1],{
    curl_version_info:{args:["i32"],returns:"ptr"},
  });
  try {
    const info=library.symbols.curl_version_info(0);
    if(!info)throw new Error("missing curl version info");
    console.log(JSON.stringify({versionNumber:read.u32(info,16),ipv6:(read.u32(info,32)&1)!==0}));
  } finally {library.close();}
`;

/** Unknown/static/unsupported linkage fails closed at the HTTPS caller. */
export async function readGitCurlRuntime(
  context: CommandContext,
  cwd: string,
): Promise<unknown> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return null;
  const options = {
    cwd,
    context: { ...context, timeoutMs: Math.min(context.timeoutMs ?? 5_000, 5_000) },
    outputLimitBytes: 16 * 1024,
  };
  try {
    const location = await runCommand(["git", "--exec-path"], options);
    const execPath = location.stdout.trim();
    if (location.exitCode !== 0 || !isAbsolute(execPath) || /[\r\n\0]/u.test(execPath)) return null;
    const linkage = await runCommand(["ldd", "--", join(execPath, "git-remote-https")], options);
    if (linkage.exitCode !== 0) return null;
    const libraries = linkage.stdout.split("\n").flatMap(line => {
      const match = /^\s*libcurl(?:-[a-z0-9]+)*\.so(?:\.\d+)*\s+=>\s+(\/\S+)\s+\(0x[0-9a-f]+\)\s*$/iu.exec(line);
      return match ? [match[1]!] : [];
    });
    if (libraries.length !== 1) return null;
    const path = await realpath(libraries[0]!);
    const result = await runCommand([
      process.execPath, "--no-env-file", "-e", READ_CURL_RUNTIME, path,
    ], { ...options, outputLimitBytes: 1024 });
    return result.exitCode === 0 ? JSON.parse(result.stdout) as unknown : null;
  } catch {
    return null;
  }
}
