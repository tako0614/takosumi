import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import { formAvailabilityHelpText } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { isRecord } from "./cli-util.ts";

export async function runFormAvailability(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(formAvailabilityHelpText());
    return 0;
  }
  if (command !== "list") {
    io.stderr(`Unknown form-availability command: ${command}`);
    io.stderr(formAvailabilityHelpText());
    return 2;
  }
  try {
    const options = parseOptions(rest);
    const space = optionalStringOption(options, "space");
    if (!space) throw new TypeError("--space is required");
    const query = new URLSearchParams({ space });
    for (const [option, parameter] of [
      ["apiVersion", "apiVersion"],
      ["kind", "kind"],
      ["definitionVersion", "definitionVersion"],
      ["schemaDigest", "schemaDigest"],
      ["packageDigest", "packageDigest"],
      ["limit", "limit"],
      ["cursor", "cursor"],
    ] as const) {
      const value = optionalStringOption(options, option);
      if (value) query.set(parameter, value);
    }
    const response = await requestDeployControlApi({
      path: `/v1/form-availability?${query.toString()}`,
      options,
    });
    io.stdout(
      booleanOption(options, "json")
        ? JSON.stringify(response, null, 2)
        : formatAvailability(response),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

function formatAvailability(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.forms)) {
    return "Invalid FormAvailability response";
  }
  if (value.forms.length === 0) return "No Service Forms discovered.";
  return [
    "Service Form availability:",
    ...value.forms.map((raw) => {
      if (!isRecord(raw) || !isRecord(raw.identity)) return "- invalid record";
      const formRef = isRecord(raw.identity.formRef)
        ? raw.identity.formRef
        : {};
      const exact = [
        formRef.apiVersion,
        formRef.kind,
        formRef.definitionVersion,
      ]
        .filter((part) => typeof part === "string")
        .join("/");
      const state = raw.availableToPrincipal
        ? "available"
        : typeof raw.availabilityReason === "string"
          ? raw.availabilityReason
          : "unavailable";
      return `- ${exact || "unknown"}: ${state}`;
    }),
  ].join("\n");
}
