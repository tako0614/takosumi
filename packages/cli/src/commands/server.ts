import { Command } from "@cliffy/command";

export const serverCommand = new Command()
  .description("Start the Takosumi kernel HTTP server")
  .option("--port <port:number>", "Port to listen on", { default: 8080 })
  .action(async ({ port }) => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "jsr:@takos/takosumi-kernel"],
      env: { PORT: String(port) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const child = cmd.spawn();
    const status = await child.status;
    Deno.exit(status.code);
  });
