import { Command } from "@cliffy/command";
import { LIFECYCLE_AGENT_URL_ENV } from "takosumi-contract";

export const serverCommand = new Command()
  .description("Start the Takosumi kernel HTTP server")
  .option("--port <port:number>", "Port to listen on", { default: 8788 })
  .option(
    "--agent-port <port:number>",
    "Port for the embedded runtime-agent (only used when TAKOSUMI_AGENT_URL is unset)",
    { default: 8789 },
  )
  .option(
    "--no-agent",
    "Skip starting the embedded runtime-agent (operator must run one separately)",
  )
  .option(
    "--detach",
    "Print a recommended systemd unit for production daemonization and " +
      "exit immediately. Deno does not provide a portable detach primitive, " +
      "so we surface the supervisor template instead of half-baked daemonising.",
  )
  .action(async ({ port, agentPort, agent, detach }) => {
    if (detach) {
      printDaemonizationTemplate(port);
      return;
    }
    const agentDisabled = agent === false;
    const agentUrl = Deno.env.get(LIFECYCLE_AGENT_URL_ENV);
    let agentShutdown: (() => Promise<void>) | undefined;
    if (!agentUrl && !agentDisabled) {
      const { startEmbeddedAgent } = await import(
        "@takos/takosumi-runtime-agent/embed"
      );
      const handle = startEmbeddedAgent({ port: agentPort });
      agentShutdown = handle.shutdown;
      console.log(
        `[takosumi-server] embedded runtime-agent listening at ${handle.url}`,
      );
      console.log(
        `[takosumi-server] (operators running an external agent should set ${LIFECYCLE_AGENT_URL_ENV})`,
      );
    }
    if (agentShutdown) {
      registerShutdownHandlers(agentShutdown);
    }
    Deno.env.set("PORT", String(port));
    await import("@takos/takosumi-kernel");
  });

function registerShutdownHandlers(shutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = (signal: Deno.Signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[takosumi-server] received ${signal}, draining...`);
    shutdown()
      .catch((err) => console.error("[takosumi-server] shutdown error:", err))
      .finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", () => handler("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => handler("SIGTERM"));
}

/**
 * Render a recommended systemd unit + docker compose snippet for
 * production daemonization. We deliberately do NOT spawn a detached
 * child process: Deno lacks a portable detach primitive
 * (`Deno.Command` keeps the parent attached on Linux even with
 * `stdin: "null"`), and a half-baked `nohup`-equivalent would silently
 * drop signals, lose stdout, and re-attach to the controlling tty on
 * some shells. systemd / docker / nohup are the right tools for this
 * job; the CLI's responsibility is to point the operator at them.
 *
 * Variants:
 *   - systemd unit (recommended for bare-metal / VM hosts)
 *   - docker compose snippet (for container-host environments)
 *   - nohup one-liner (for quick adhoc tests; not for production)
 */
function printDaemonizationTemplate(port: number): void {
  const exec = Deno.execPath();
  const lines = [
    "[takosumi] --detach is fire-and-forget: pick a supervisor template.",
    "",
    "1. systemd (recommended for VM / bare-metal hosts)",
    "",
    "   # /etc/systemd/system/takosumi-api.service",
    "   [Unit]",
    "   Description=Takosumi kernel",
    "   After=network-online.target",
    "",
    "   [Service]",
    `   ExecStart=${exec} run -A jsr:@takos/takosumi-cli server --port ${port}`,
    "   Environment=TAKOSUMI_DEPLOY_TOKEN=...",
    "   Environment=TAKOSUMI_DATABASE_URL=postgres://...",
    "   Restart=always",
    "   RestartSec=5",
    "",
    "   [Install]",
    "   WantedBy=multi-user.target",
    "",
    "   sudo systemctl daemon-reload && sudo systemctl enable --now takosumi-api",
    "",
    "2. docker compose (for container hosts)",
    "",
    "   services:",
    "     takosumi-api:",
    "       image: denoland/deno:alpine",
    `       command: run -A jsr:@takos/takosumi-cli server --port ${port}`,
    "       environment:",
    "         TAKOSUMI_DEPLOY_TOKEN: ${TAKOSUMI_DEPLOY_TOKEN}",
    "         TAKOSUMI_DATABASE_URL: ${TAKOSUMI_DATABASE_URL}",
    `       ports: [\"${port}:${port}\"]`,
    "       restart: unless-stopped",
    "",
    "3. nohup (adhoc / not for production)",
    "",
    `   nohup takosumi server --port ${port} > /var/log/takosumi.log 2>&1 &`,
    "",
    "(Deno lacks a portable detach primitive; a CLI-level daemoniser would " +
    "silently drop signals and stdout. Use a real supervisor.)",
  ];
  for (const line of lines) console.log(line);
}
