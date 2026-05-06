import app from "@takos/takosumi-kernel";

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8788");
  const server = Deno.serve({ port }, app.fetch);
  registerShutdownHandlers(server);
}

export default app;

function registerShutdownHandlers(server: Deno.HttpServer): void {
  let shuttingDown = false;
  const handler = (signal: Deno.Signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[takosumi] received ${signal}, draining HTTP server...`);
    server.shutdown()
      .catch((error) => console.error("[takosumi] shutdown error:", error))
      .finally(() => {
        console.log("[takosumi] shutdown complete");
        Deno.exit(0);
      });
  };

  try {
    Deno.addSignalListener("SIGINT", () => handler("SIGINT"));
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGTERM", () => handler("SIGTERM"));
    }
  } catch (error) {
    console.warn(
      `[takosumi] failed to register shutdown signal handlers: ${
        (error as Error).message
      }`,
    );
  }
}
