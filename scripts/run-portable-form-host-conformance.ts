#!/usr/bin/env bun
import type { InstalledFormReference, JsonObject } from "takosumi-contract";
import { isInstalledFormReference } from "takosumi-contract";
import {
  runPortableFormHostConformance,
  type PortableFormHostNegativeFixture,
} from "../core/conformance/portable_form_host.ts";

const args = parseArgs(process.argv.slice(2));
validateArgs(args);
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
if (args["import-native-id-env"] && !importNativeId) {
  throw new TypeError(
    `import native id environment variable ${args["import-native-id-env"]} is empty`,
  );
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
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseArgs(values: readonly string[]): Record<string, string> {
  if (values.length % 2 !== 0) {
    throw new TypeError(usage());
  }
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    const name = key?.slice(2) ?? "";
    if (!key?.startsWith("--") || !value || result[name] !== undefined) {
      throw new TypeError(usage());
    }
    result[name] = value;
  }
  return result;
}

function validateArgs(values: Readonly<Record<string, string>>): void {
  const allowed = new Set([
    "desired",
    "endpoint",
    "identity",
    "import-native-id-env",
    "name",
    "negative-fixtures",
    "positive-fixture-name",
    "space",
    "token-env",
    "updated-desired",
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) {
      throw new TypeError(`unknown argument --${name}\n${usage()}`);
    }
  }
}

function usage(): string {
  return "usage: --endpoint URL --space ID --name NAME --identity FILE --desired FILE [--updated-desired FILE] [--positive-fixture-name NAME] [--negative-fixtures FILE] [--token-env ENV] [--import-native-id-env ENV]";
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
): Promise<readonly PortableFormHostNegativeFixture[]> {
  const value = await readJson(path);
  if (!Array.isArray(value) || !value.every(isNegativeFixture)) {
    throw new TypeError(
      "--negative-fixtures must contain a portable host negative-fixture JSON array",
    );
  }
  return value;
}

function isNegativeFixture(
  value: unknown,
): value is PortableFormHostNegativeFixture {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    (value.stage === "config" || value.stage === "desired") &&
    isObject(value.input) &&
    typeof value.expectedErrorCode === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
