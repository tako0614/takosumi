import { Command } from "../command.ts";
import { currentRuntime } from "../../core/shared/runtime/index.ts";

function createServerCommand(): Command {
  return new Command("server")
    .description("Start the Takosumi service HTTP server")
    .option("--port <port>", "Port to listen on", (v) => Number(v), 8788)
    .option(
      "--detach",
      "Print a recommended systemd unit for production daemonization and " +
        "exit immediately. The CLI does not provide a portable detach primitive, " +
        "so we surface the supervisor template instead of half-baked daemonising.",
    )
    .action(async (
      { port, detach }: {
        port: number;
        detach?: boolean;
      },
    ) => {
      if (detach) {
        printDaemonizationTemplate(port);
        return;
      }
      const runtime = currentRuntime();
      runtime.env.set("PORT", String(port));
      await import("../../core/index.ts");
    });
}

/**
 * Render a recommended systemd unit + docker compose snippet for
 * production daemonization. We deliberately do NOT spawn a detached
 * child process: host subprocess APIs differ enough that some keep the parent
 * attached on Linux even with
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
  const exec = currentRuntime().execPath();
  // Takosumi is not npm-published; the CLI runs in-repo against the cloned
  // source, so the supervisor templates invoke the source entry point
  // (`src/cli/main.ts`) rather than a non-existent published binary.
  const cliEntry = "/path/to/takosumi/src/cli/main.ts";
  const lines = [
    "[takosumi] --detach is fire-and-forget: pick a supervisor template.",
    "",
    "1. systemd (recommended for VM / bare-metal hosts)",
    "",
    "   # /etc/systemd/system/takosumi-api.service",
    "   [Unit]",
    "   Description=Takosumi service",
    "   After=network-online.target",
    "",
    "   [Service]",
    "   WorkingDirectory=/path/to/takosumi",
    `   ExecStart=${exec} ${cliEntry} server --port ${port}`,
    "   Environment=TAKOSUMI_DEPLOY_CONTROL_TOKEN=...",
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
    "       image: oven/bun:1",
    "       working_dir: /app",
    `       command: bun src/cli/main.ts server --port ${port}`,
    "       environment:",
    "         TAKOSUMI_DEPLOY_CONTROL_TOKEN: ${TAKOSUMI_DEPLOY_CONTROL_TOKEN}",
    "         TAKOSUMI_DATABASE_URL: ${TAKOSUMI_DATABASE_URL}",
    `       ports: [\"${port}:${port}\"]`,
    "       restart: unless-stopped",
    "",
    "3. nohup (adhoc / not for production)",
    "",
    `   nohup ${exec} ${cliEntry} server --port ${port} > /var/log/takosumi.log 2>&1 &`,
    "",
    "(A CLI-level daemoniser would " +
    "silently drop signals and stdout. Use a real supervisor.)",
  ];
  for (const line of lines) console.log(line);
}

export const serverCommand: Command = createServerCommand();
