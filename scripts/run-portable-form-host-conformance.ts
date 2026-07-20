#!/usr/bin/env bun
import type {
  InstalledFormReference,
  JsonObject,
  StandardFormNegativeFixture,
} from "takosumi-contract";
import { isInstalledFormReference } from "takosumi-contract";
import {
  portableStandardHostRunnerReport,
  runPortableFormHostConformance,
} from "../core/conformance/portable_form_host.ts";

const args = parseArgs(process.argv.slice(2));
const endpoint = required(args, "endpoint");
const space = required(args, "space");
const name = required(args, "name");
const identity = await readJson(required(args, "identity"));
if (!isInstalledFormReference(identity)) {
  throw new TypeError(
    "--identity must contain one exact InstalledFormReference",
  );
}
const desired = await readJson(required(args, "desired"));
if (!isObject(desired))
  throw new TypeError("--desired must contain a JSON object");
const updatedDesired = args["updated-desired"]
  ? await readJson(args["updated-desired"])
  : undefined;
if (updatedDesired !== undefined && !isObject(updatedDesired)) {
  throw new TypeError("--updated-desired must contain a JSON object");
}
const positiveFixtureName = args["positive-fixture-name"] ?? "canonical";
const negativeFixtures = args["negative-fixtures"]
  ? await readNegativeFixtures(args["negative-fixtures"])
  : [];
const token = args["token-env"] ? process.env[args["token-env"]] : undefined;
if (args["token-env"] && !token) {
  throw new TypeError(
    `token environment variable ${args["token-env"]} is empty`,
  );
}
const importNativeId = args["import-native-id-env"]
  ? process.env[args["import-native-id-env"]]
  : undefined;
const expectDrift = args["expect-drift"] === "true";
if (args["expect-drift"] && !["true", "false"].includes(args["expect-drift"])) {
  throw new TypeError("--expect-drift must be true or false");
}
const driftSignalFile = args["drift-signal-file"];
if (driftSignalFile && !expectDrift) {
  throw new TypeError("--drift-signal-file requires --expect-drift true");
}
if (expectDrift && !driftSignalFile) {
  throw new TypeError(
    "--expect-drift true requires --drift-signal-file so an external backend mutator can signal completion",
  );
}
if (driftSignalFile && (await Bun.file(driftSignalFile).exists())) {
  throw new TypeError("--drift-signal-file must not exist before the run");
}
const outputFormat = args["output-format"] ?? "portable-report";
if (!["portable-report", "standard-runner-report"].includes(outputFormat)) {
  throw new TypeError(
    "--output-format must be portable-report or standard-runner-report",
  );
}
if (outputFormat === "standard-runner-report") {
  const missing: string[] = [];
  if (!updatedDesired) missing.push("--updated-desired");
  if (negativeFixtures.length === 0) missing.push("--negative-fixtures");
  if (!importNativeId) missing.push("--import-native-id-env with a set value");
  if (!expectDrift) missing.push("--expect-drift true --drift-signal-file");
  if (missing.length > 0) {
    throw new TypeError(
      `standard-runner-report requires ${missing.join(", ")}`,
    );
  }
}

const report = await runPortableFormHostConformance({
  endpoint,
  space,
  name,
  identity,
  desired: desired as JsonObject,
  ...(updatedDesired ? { updatedDesired: updatedDesired as JsonObject } : {}),
  positiveFixtureName,
  negativeFixtures,
  ...(token ? { token } : {}),
  ...(importNativeId ? { importNativeId } : {}),
  ...(driftSignalFile
    ? {
        expectDrift: true,
        beforeDriftObserve: async ({
          canonicalResourceId,
          resourceVersion,
        }: {
          canonicalResourceId: string;
          resourceVersion: string;
        }) => {
          console.error(
            JSON.stringify({
              event: "awaiting-external-drift",
              canonicalResourceId,
              resourceVersion,
              signalFile: driftSignalFile,
            }),
          );
          await waitForSignal(driftSignalFile);
        },
      }
    : {}),
});
if (outputFormat === "standard-runner-report") {
  const standard = await portableStandardHostRunnerReport(report);
  // Takoform retains and signs exact RFC 8785 bytes. A trailing newline would
  // make the subject non-canonical and is therefore deliberately omitted.
  process.stdout.write(standard.canonical);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new TypeError(
        "usage: --endpoint URL --space ID --name NAME --identity FILE --desired FILE [--updated-desired FILE] [--positive-fixture-name NAME] [--negative-fixtures FILE] [--token-env ENV] [--import-native-id-env ENV] [--expect-drift true --drift-signal-file FILE] [--output-format portable-report|standard-runner-report]",
      );
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function waitForSignal(path: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(250);
  }
  throw new Error("timed out waiting for external drift mutation signal");
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new TypeError(`--${key} is required`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text()) as unknown;
}

async function readNegativeFixtures(
  path: string,
): Promise<readonly StandardFormNegativeFixture[]> {
  const value = await readJson(path);
  if (!Array.isArray(value) || !value.every(isNegativeFixture)) {
    throw new TypeError(
      "--negative-fixtures must contain a StandardFormNegativeFixture JSON array",
    );
  }
  return value;
}

function isNegativeFixture(
  value: unknown,
): value is StandardFormNegativeFixture {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.stage === "string" &&
    isObject(value.input) &&
    typeof value.expectedErrorCode === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
