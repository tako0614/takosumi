import { startKernel } from "@takos/takosumi-kernel/server";

export { startKernel };

// Derive the runtime adapter / serve-handle types from the kernel's public
// `startKernel` return so this module routes HTTP serving through the kernel
// `RuntimeAdapter` (packages/kernel/src/shared/runtime/) instead of touching
// `Deno.*` directly. This keeps the substrate-neutral boundary intact and the
// npm build typeable on Node.
type StartedKernel = Awaited<ReturnType<typeof startKernel>>;
type KernelRuntime = StartedKernel["runtime"];
type KernelServeHandle = ReturnType<KernelRuntime["serveHttp"]>;

if (import.meta.main) {
  const { app, runtime } = await startKernel();
  const port = Number(runtime.env.get("PORT") ?? "8788");
  const server = runtime.serveHttp(app.fetch, { port });
  registerShutdownHandlers(runtime, server);
}

function registerShutdownHandlers(
  runtime: KernelRuntime,
  server: KernelServeHandle,
): void {
  let shuttingDown = false;
  const handler = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[takosumi] received ${signal}, draining HTTP server...`);
    server.shutdown()
      .catch((error: unknown) =>
        console.error("[takosumi] shutdown error:", error)
      )
      .finally(() => {
        console.log("[takosumi] shutdown complete");
        runtime.exit(0);
      });
  };

  runtime.onSignal("SIGINT", () => handler("SIGINT"));
  runtime.onSignal("SIGTERM", () => handler("SIGTERM"));
}
