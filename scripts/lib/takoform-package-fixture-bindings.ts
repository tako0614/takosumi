import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import type {
  InstalledFormReference,
  JsonObject,
  StandardFormNegativeFixture,
} from "takosumi-contract";
import { canonicalJson } from "../../core/adapters/takoform/canonical_json.ts";

export async function readExactPackageFixtureBindings(input: {
  readonly root: string;
  readonly identity: InstalledFormReference;
  readonly positiveFixtureName: string;
  readonly desired: JsonObject;
  readonly negativeFixtures: readonly StandardFormNegativeFixture[];
}): Promise<{
  readonly positive: string;
  readonly negative: Readonly<Record<string, string>>;
}> {
  const root = resolve(input.root);
  const index = await readPackageObject(root, "package-index.json");
  if (canonicalJson(index.formRef) !== canonicalJson(input.identity.formRef)) {
    throw new TypeError(
      "--package-root FormRef does not equal the installed identity",
    );
  }
  const files = index.files;
  if (!Array.isArray(files)) {
    throw new TypeError("--package-root package-index files are missing");
  }
  const listed = new Map<string, { readonly digest: string }>();
  for (const value of files) {
    if (
      !isObject(value) ||
      typeof value.path !== "string" ||
      typeof value.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
      listed.has(value.path)
    ) {
      throw new TypeError("--package-root contains an invalid file index");
    }
    listed.set(value.path, { digest: value.digest });
  }
  if (typeof index.definitionPath !== "string") {
    throw new TypeError("--package-root definitionPath is missing");
  }
  const definitionReadback = await readListedPackageObject(
    root,
    index.definitionPath,
    listed,
  );
  const definition = definitionReadback.value;
  const formRef = input.identity.formRef;
  if (
    definition.apiVersion !== formRef.apiVersion ||
    definition.kind !== formRef.kind ||
    definition.definitionVersion !== formRef.definitionVersion ||
    `sha256:${sha256(canonicalJson(definition))}` !== formRef.schemaDigest
  ) {
    throw new TypeError(
      "--package-root definition does not bind the installed FormRef",
    );
  }
  if (!Array.isArray(definition.conformanceFixtures)) {
    throw new TypeError("--package-root positive fixtures are missing");
  }
  const positive = definition.conformanceFixtures.find(
    (value) => isObject(value) && value.name === input.positiveFixtureName,
  );
  if (!isObject(positive) || typeof positive.desiredPath !== "string") {
    throw new TypeError(
      `--package-root does not contain positive fixture ${input.positiveFixtureName}`,
    );
  }
  const desiredReadback = await readListedPackageObject(
    root,
    positive.desiredPath,
    listed,
  );
  if (canonicalJson(desiredReadback.value) !== canonicalJson(input.desired)) {
    throw new TypeError(
      "--desired does not equal the exact retained package fixture",
    );
  }

  if (!Array.isArray(definition.negativeConformanceFixtures)) {
    throw new TypeError("--package-root negative fixtures are missing");
  }
  const requested = new Map(
    input.negativeFixtures.map((fixture) => [fixture.name, fixture] as const),
  );
  if (
    requested.size !== input.negativeFixtures.length ||
    requested.size !== definition.negativeConformanceFixtures.length
  ) {
    throw new TypeError(
      "--negative-fixtures must equal the exact retained package fixture closure",
    );
  }
  const negative: Record<string, string> = {};
  for (const value of definition.negativeConformanceFixtures) {
    if (
      !isObject(value) ||
      typeof value.name !== "string" ||
      typeof value.stage !== "string" ||
      typeof value.inputPath !== "string"
    ) {
      throw new TypeError(
        "--package-root contains an invalid negative fixture",
      );
    }
    const executed = requested.get(value.name);
    if (!executed || executed.stage !== value.stage) {
      throw new TypeError(
        `negative fixture ${value.name} does not equal the retained stage`,
      );
    }
    const readback = await readListedPackageObject(
      root,
      value.inputPath,
      listed,
    );
    if (canonicalJson(readback.value) !== canonicalJson(executed.input)) {
      throw new TypeError(
        `negative fixture ${value.name} input does not equal the retained package fixture`,
      );
    }
    negative[value.name] = readback.digest;
  }
  return { positive: desiredReadback.digest, negative };
}

async function readListedPackageObject(
  root: string,
  path: string,
  listed: ReadonlyMap<string, { readonly digest: string }>,
): Promise<{ readonly value: JsonObject; readonly digest: string }> {
  const descriptor = listed.get(path);
  if (!descriptor) {
    throw new TypeError(`--package-root does not list ${path}`);
  }
  const absolute = safePackagePath(root, path);
  const raw = new Uint8Array(await Bun.file(absolute).arrayBuffer());
  const digest = `sha256:${sha256(raw)}`;
  if (digest !== descriptor.digest) {
    throw new TypeError(`--package-root readback digest drifted for ${path}`);
  }
  const value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  if (!isObject(value)) {
    throw new TypeError(`--package-root ${path} must contain a JSON object`);
  }
  return { value, digest };
}

async function readPackageObject(
  root: string,
  path: string,
): Promise<JsonObject> {
  const value = JSON.parse(
    await Bun.file(safePackagePath(root, path)).text(),
  ) as unknown;
  if (!isObject(value)) {
    throw new TypeError(`--package-root ${path} must contain a JSON object`);
  }
  return value;
}

function safePackagePath(root: string, path: string): string {
  if (path.trim() === "" || path.startsWith("/") || path.includes("\\")) {
    throw new TypeError(`--package-root contains an unsafe path ${path}`);
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../")) {
    throw new TypeError(`--package-root contains an unsafe path ${path}`);
  }
  return absolute;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
