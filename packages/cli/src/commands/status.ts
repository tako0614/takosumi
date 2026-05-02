import { Command } from "@cliffy/command";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";

export const statusCommand = new Command()
  .description("Show current resource status")
  .arguments("[name:string]")
  .option("--remote <url:string>", "Remote kernel URL")
  .option("--token <token:string>", "Auth token")
  .action(async ({ remote, token }, name) => {
    const target = resolveMode({ remote, token }, loadConfig());
    if (target.mode !== "remote") {
      console.log("local status not yet wired");
      return;
    }
    const path = name
      ? `/v1/deployments/${encodeURIComponent(name)}`
      : "/v1/deployments";
    const { status, body } = await callKernel({
      url: target.url,
      token: target.token,
      path,
      method: "GET",
    });
    if (status >= 400) {
      console.error(`kernel returned ${status}:`, body);
      Deno.exit(1);
    }
    console.log(JSON.stringify(body, null, 2));
  });
