import { dlopen, FFIType } from "bun:ffi";

// The real cached runtime executes this trusted runner child after the actual
// production launcher. A separate same-UID provider then attacks its proc FDs.
const native = dlopen("/proof/libhosted-metered-supervisor.so", {
  takosumi_meter_harden_child: { args: [], returns: FFIType.i32 },
  takosumi_meter_child_protected: { args: [], returns: FFIType.i32 },
});
try {
  if (native.symbols.takosumi_meter_harden_child() !== 0) {
    throw new Error("real Bun post-exec child protection is unavailable");
  }
  const child = Bun.spawn(
    ["/proof/hosted-metered-fixture", "probe", String(process.pid)],
    {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    console.error(errors);
    throw new Error("same-UID provider reached a protected runner boundary");
  }
  const result = JSON.parse(output);
  if (result.ok !== true || result.protectedBunParent !== true ||
    native.symbols.takosumi_meter_child_protected() !== 0) {
    throw new Error("Bun child protection changed after the provider attack");
  }
  const { readFileSync } = await import("node:fs");
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const listeners = readFileSync(path, "utf8").split("\n").slice(1)
      .filter((line) => line.trim().split(/\s+/)[3] === "0A");
    if (listeners.length !== 0) {
      throw new Error("debug signal activated an unexpected TCP listener");
    }
  }
  console.log(JSON.stringify(result));
  console.log(JSON.stringify({
    type: "bun-child-protected",
    uid: process.getuid?.(),
    dumpableAfterExec: 0,
    ok: true,
  }));
} finally {
  native.close();
}
