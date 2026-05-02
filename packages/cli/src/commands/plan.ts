import { Command } from "@cliffy/command";
import { loadManifest } from "../manifest_loader.ts";

export const planCommand = new Command()
  .description("Print the resolved plan without applying")
  .arguments("<manifest:string>")
  .action(async (_options, manifestPath) => {
    const manifest = await loadManifest(manifestPath);
    console.log(`loaded manifest from ${manifest.path} (${manifest.format})`);
    console.log(JSON.stringify(manifest.value, null, 2));
  });
