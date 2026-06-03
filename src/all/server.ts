import { startTakosumiService } from "../service/index.ts";

export { startTakosumiService };

// Derive the runtime adapter / serve-handle types from the service's public
// `startTakosumiService` return so this module routes HTTP serving through the service
// `RuntimeAdapter` (`src/service/shared/runtime/`) instead of touching
// host-specific globals directly. This keeps the substrate-neutral boundary intact and the
// npm build typeable on Node.
type StartedTakosumiService = Awaited<ReturnType<typeof startTakosumiService>>;
type ServiceRuntime = StartedTakosumiService["runtime"];
type ServiceServeHandle = ReturnType<ServiceRuntime["serveHttp"]>;

if (import.meta.main) {
  const { app, runtime } = await startTakosumiService();
  const port = Number(runtime.env.get("PORT") ?? "8788");
  const server = runtime.serveHttp(app.fetch, { port });
  registerShutdownHandlers(runtime, server);
}

function registerShutdownHandlers(
  runtime: ServiceRuntime,
  server: ServiceServeHandle,
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
