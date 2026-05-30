/**
 * Generate TypeScript types from package-owned kind descriptors
 * (`src/kinds/<name>/spec/kind.jsonld`).
 *
 * For TypeScript helper generation, each official catalog descriptor source
 * file supplies its `spec` shape (= JSON Schema 2020-12 form), `outputs` list,
 * `capabilityTerms` enum, output slot envelope
 * (`referenceAliases` / `outputSlots{}`), and optional consumer-slot
 * compatibility metadata (`listens{}`). The generator emits a
 * sibling `src/kinds/<name>/src/<basename>.generated.ts`
 * containing:
 *
 *   - `<Prefix>Spec` interface (derived from JSON Schema)
 *   - `<Prefix>Outputs` interface (derived from `outputs` array)
 *   - `<Prefix>CapabilityTerm` string union (derived from `capabilityTerms` array)
 *   - `<Prefix>OutputSlotName` string union (= local output slot names)
 *   - `<Prefix>OutputSlotContract` string union (= output slot contracts)
 *   - `<Prefix>OutputSlotDescriptor` interface and
 *     `<UPPER>_OUTPUT_SLOT_DESCRIPTORS` const array
 *   - `<UPPER>_CAPABILITY_TERMS` / `<UPPER>_OUTPUT_FIELDS` /
 *     `<UPPER>_ALIASES` (referenceAlias suggestions only) /
 *     `<UPPER>_OUTPUT_SLOTS` const arrays
 *   - `<UPPER>_KIND_SHAPE_ID` / `<UPPER>_KIND_ID` (deprecated alias) /
 *     `<UPPER>_KIND_NAME` /
 *     `<UPPER>_KIND_URI` / `<UPPER>_KIND_VERSION` /
 *     `<UPPER>_DESCRIPTION`
 *
 * Hand-written sibling `<basename>.ts` re-exports the generated types and
 * adds the `Shape` descriptor + runtime validators (which are NOT
 * generated, to keep validation diagnostics human-curated).
 *
 * TypeScript naming is repo-local generator policy. Public JSON-LD descriptor
 * bodies stay free of `x-*` tooling metadata.
 */
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

interface JsonSchema {
  readonly title?: string;
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly propertyNames?: JsonSchema;
  readonly description?: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly pattern?: string;
  readonly $schema?: string;
}

interface OutputSlotDescriptor {
  readonly contract: string;
  readonly exampleMaterialMapping?: Record<string, unknown>;
  readonly material?: Record<string, unknown>;
  readonly from?: unknown;
}

interface ListenSlotDescriptor {
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Record<string, readonly string[]>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

interface KindDoc {
  readonly "@context"?: unknown;
  readonly "@id": string;
  readonly "@type"?: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly referenceAliases?: readonly string[];
  readonly outputSlots?: Record<string, OutputSlotDescriptor>;
  readonly listens?: Record<string, ListenSlotDescriptor>;
  readonly spec: JsonSchema;
  readonly outputs: readonly OutputField[];
  readonly capabilityTerms: readonly string[];
}

interface OutputField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly meaning?: string;
  readonly items?: JsonSchema;
  /**
   * Closed value set for `string` outputs. When present the generated type is
   * the union of these literals instead of bare `string`, matching the
   * runtime validator (mirrors the `enum` handling in {@link renderTsType}).
   */
  readonly enum?: readonly string[];
}

interface NestedType {
  readonly name: string;
  readonly source: JsonSchema;
}

interface GeneratorContext {
  readonly prefix: string;
  readonly nested: NestedType[];
  readonly imports: Map<string, Set<string>>;
}

interface KindSourceTarget {
  readonly source: string;
  readonly sourceBasename: string;
  readonly outputDir: string;
}

const KIND_SOURCE_TARGETS: readonly KindSourceTarget[] = [
  {
    source: "../src/kinds/worker/spec/kind.jsonld",
    sourceBasename: "worker",
    outputDir: "../src/kinds/worker/src",
  },
  {
    source: "../src/kinds/web-service/spec/kind.jsonld",
    sourceBasename: "web-service",
    outputDir: "../src/kinds/web-service/src",
  },
  {
    source: "../src/kinds/postgres/spec/kind.jsonld",
    sourceBasename: "postgres",
    outputDir: "../src/kinds/postgres/src",
  },
  {
    source: "../src/kinds/object-store/spec/kind.jsonld",
    sourceBasename: "object-store",
    outputDir: "../src/kinds/object-store/src",
  },
  {
    source: "../src/kinds/gateway/spec/kind.jsonld",
    sourceBasename: "gateway",
    outputDir: "../src/kinds/gateway/src",
  },
  {
    source: "../src/kinds/sqlite/spec/kind.jsonld",
    sourceBasename: "sqlite",
    outputDir: "../src/kinds/sqlite/src",
  },
  {
    source: "../src/kinds/kv-store/spec/kind.jsonld",
    sourceBasename: "kv-store",
    outputDir: "../src/kinds/kv-store/src",
  },
  {
    source: "../src/kinds/message-queue/spec/kind.jsonld",
    sourceBasename: "message-queue",
    outputDir: "../src/kinds/message-queue/src",
  },
  {
    source: "../src/kinds/vector-store/spec/kind.jsonld",
    sourceBasename: "vector-store",
    outputDir: "../src/kinds/vector-store/src",
  },
];

function sourcePath(target: KindSourceTarget): string {
  return fromFileUrl(new URL(target.source, import.meta.url));
}

function outputPath(target: KindSourceTarget): string {
  return fromFileUrl(new URL(target.outputDir, import.meta.url));
}
const HEADER = "// AUTO-GENERATED FROM package-owned kind descriptor " +
  "spec/kind.jsonld — DO NOT EDIT.\n" +
  "// Run `deno task spec:generate-ts` to refresh.\n";
const TS_GENERATION_OVERRIDES: Readonly<
  Record<string, { readonly fileBasename: string; readonly prefix: string }>
> = {
  gateway: { fileBasename: "gateway", prefix: "Gateway" },
  "kv-store": { fileBasename: "kv-store", prefix: "KvStore" },
  "message-queue": {
    fileBasename: "message-queue",
    prefix: "MessageQueue",
  },
  "object-store": { fileBasename: "object-store", prefix: "ObjectStore" },
  postgres: { fileBasename: "database-postgres", prefix: "DatabasePostgres" },
  sqlite: { fileBasename: "sqlite", prefix: "Sqlite" },
  "vector-store": { fileBasename: "vector-store", prefix: "VectorStore" },
  "web-service": { fileBasename: "web-service", prefix: "WebService" },
  worker: { fileBasename: "worker", prefix: "Worker" },
};

if (import.meta.main) {
  const result = await main();
  Deno.exit(result);
}

async function main(): Promise<number> {
  const docs = await loadKindDocs();
  const written: string[] = [];
  for (const loaded of docs) {
    const ts = generateTs(loaded.doc, loaded.sourceBasename);
    const target = generationTarget(loaded.doc, loaded.sourceBasename);
    const outPath = `${loaded.outputDir}/${target.fileBasename}.generated.ts`;
    await Deno.writeTextFile(outPath, ts);
    written.push(outPath);
    console.log(
      `[spec:generate-ts] wrote ${outPath} (${loaded.doc.name}@${loaded.doc.version}, ${
        loaded.doc["@id"]
      })`,
    );
  }
  // Normalize output through `deno fmt` so it is byte-stable across runs
  // and matches workspace formatting.
  await formatFiles(written);
  return 0;
}

export async function formatFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--quiet", ...paths],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    const msg = new TextDecoder().decode(stderr);
    throw new Error(`deno fmt failed: ${msg}`);
  }
}

/**
 * Library entry: generate all kinds in a temp directory and return
 * (basename, formatted text) pairs. Used by `spec-check-drift.ts` to
 * compare against the on-disk files without mutating them.
 */
export async function generateAllToTemp(): Promise<
  ReadonlyMap<string, string>
> {
  const tmpDir = await Deno.makeTempDir({ prefix: "takosumi-spec-gen-" });
  try {
    const docs = await loadKindDocs();
    const paths: string[] = [];
    const map = new Map<string, string>();
    for (const loaded of docs) {
      const ts = generateTs(loaded.doc, loaded.sourceBasename);
      const target = generationTarget(loaded.doc, loaded.sourceBasename);
      const outPath = `${tmpDir}/${target.fileBasename}.generated.ts`;
      await Deno.writeTextFile(outPath, ts);
      paths.push(outPath);
      map.set(target.fileBasename, outPath);
    }
    await formatFiles(paths);
    const out = new Map<string, string>();
    for (const [basename, path] of map.entries()) {
      out.set(basename, await Deno.readTextFile(path));
    }
    return out;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

export function generatedKindTargets(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const source of KIND_SOURCE_TARGETS) {
    const target = generationTarget(
      { name: source.sourceBasename } as KindDoc,
      source.sourceBasename,
    );
    out.set(
      target.fileBasename,
      `${outputPath(source)}/${target.fileBasename}.generated.ts`,
    );
  }
  return out;
}

export function outputDir(): string {
  return fromFileUrl(new URL("../packages", import.meta.url));
}

export interface LoadedKindDoc {
  readonly path: string;
  readonly sourceBasename: string;
  readonly outputDir: string;
  readonly doc: KindDoc;
}

export async function loadKindDocs(): Promise<readonly LoadedKindDoc[]> {
  const out: LoadedKindDoc[] = [];
  for (const target of KIND_SOURCE_TARGETS) {
    const path = sourcePath(target);
    const text = await Deno.readTextFile(path);
    const doc = JSON.parse(text) as KindDoc;
    validateKindDoc(path, doc);
    out.push({
      path,
      sourceBasename: target.sourceBasename,
      outputDir: outputPath(target),
      doc,
    });
  }
  return out;
}

export function generateTs(doc: KindDoc, sourceBasename?: string): string {
  const target = generationTarget(doc, sourceBasename);
  const ctx: GeneratorContext = {
    prefix: target.prefix,
    nested: [],
    imports: new Map(),
  };
  const upper = camelToUpper(target.prefix);
  const specInterfaceName = `${target.prefix}Spec`;
  const outputsInterfaceName = `${target.prefix}Outputs`;
  const capabilityTermTypeName = `${target.prefix}CapabilityTerm`;
  const outputFieldTypeName = `${target.prefix}OutputFieldName`;
  const outputSlotsTypeName = `${target.prefix}OutputSlotName`;

  // First pass: collect nested types from spec schema (also generates
  // their inline forms so we know what to emit at top level).
  const specBody = renderObject(doc.spec, ctx, specInterfaceName);
  // After processing spec, ctx.nested contains all nested interfaces.

  const outputsBody = renderOutputs(doc.outputs, ctx);

  const capabilityUnion = doc.capabilityTerms.length === 0
    ? "never"
    : doc.capabilityTerms.map((c) => JSON.stringify(c)).join("\n  | ");
  const capabilityArrayLiteral = arrayLiteral(doc.capabilityTerms);
  const outputFieldsArrayLiteral = arrayLiteral(doc.outputs.map((o) => o.name));
  const outputFieldUnion = doc.outputs.length === 0
    ? "never"
    : doc.outputs.map((o) => JSON.stringify(o.name)).join("\n  | ");

  const referenceAliases = doc.referenceAliases ?? [];
  const aliasesArrayLiteral = referenceAliases.length === 0
    ? ""
    : referenceAliases.map((a) => JSON.stringify(a)).join(",\n  ");

  const outputSlotNames = Object.keys(doc.outputSlots ?? {});
  const outputSlotsUnion = outputSlotNames.length === 0
    ? "never"
    : outputSlotNames.map((p) => JSON.stringify(p)).join("\n  | ");
  const outputSlotsArrayLiteral = outputSlotNames.length === 0
    ? ""
    : outputSlotNames.map((p) => JSON.stringify(p)).join(",\n  ");
  const outputSlotContracts = [
    ...new Set(
      outputSlotNames
        .map((p) => doc.outputSlots?.[p]?.contract)
        .filter((contract): contract is string => typeof contract === "string"),
    ),
  ];
  const outputSlotContractsUnion = outputSlotContracts.length === 0
    ? "never"
    : outputSlotContracts.map((p) => JSON.stringify(p)).join("\n  | ");
  const outputSlotDescriptorsArrayLiteral = outputSlotNames.length === 0
    ? ""
    : outputSlotNames
      .map((p) => renderOutputSlotDescriptor(p, doc.outputSlots?.[p]))
      .join(",\n  ");
  const listenSlotNames = Object.keys(doc.listens ?? {});
  const listenSlotsArrayLiteral = listenSlotNames.length === 0
    ? ""
    : listenSlotNames
      .map((name) => renderListenSlotDescriptor(name, doc.listens?.[name]))
      .join(",\n  ");

  const importLines = renderImports(ctx.imports);
  const nestedBlocks = ctx.nested
    .map((n) => renderNestedInterface(n, ctx))
    .join("\n");

  const basename = sourceBasename ?? target.fileBasename;
  const header = HEADER.replace("<basename>", basename);

  const parts: string[] = [header];
  if (importLines.length > 0) {
    parts.push(importLines);
    parts.push("");
  }
  if (nestedBlocks.length > 0) {
    parts.push(nestedBlocks);
  }
  parts.push(`export interface ${specInterfaceName} ${specBody}`);
  parts.push("");
  parts.push(`export interface ${outputsInterfaceName} ${outputsBody}`);
  parts.push("");
  parts.push(
    `export type ${capabilityTermTypeName} =\n  | ${capabilityUnion};`,
  );
  parts.push("");
  parts.push(
    `export type ${outputFieldTypeName} =\n  | ${outputFieldUnion};`,
  );
  parts.push("");
  parts.push(
    `export type ${outputSlotsTypeName} =\n  | ${outputSlotsUnion};`,
  );
  parts.push("");
  parts.push(
    `export type ${target.prefix}OutputSlotContract =\n  | ${outputSlotContractsUnion};`,
  );
  parts.push("");
  parts.push(
    `export interface ${target.prefix}OutputSlotDescriptor {
  readonly name: ${outputSlotsTypeName};
  readonly contract: ${target.prefix}OutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}`,
  );
  parts.push("");
  parts.push(
    `export interface ${target.prefix}ListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_CAPABILITY_TERMS: readonly ${capabilityTermTypeName}[] = ${capabilityArrayLiteral};`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_OUTPUT_FIELDS: readonly ${outputFieldTypeName}[] = ${outputFieldsArrayLiteral};`,
  );
  parts.push("");
  parts.push(
    "// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.",
  );
  if (referenceAliases.length === 0) {
    parts.push(`export const ${upper}_ALIASES: readonly string[] = [];`);
  } else {
    parts.push(
      `export const ${upper}_ALIASES: readonly string[] = [\n  ${aliasesArrayLiteral},\n];`,
    );
  }
  parts.push("");
  if (outputSlotNames.length === 0) {
    parts.push(
      `export const ${upper}_OUTPUT_SLOTS: readonly ${outputSlotsTypeName}[] = [];`,
    );
  } else {
    parts.push(
      `export const ${upper}_OUTPUT_SLOTS: readonly ${outputSlotsTypeName}[] = [\n  ${outputSlotsArrayLiteral},\n];`,
    );
  }
  parts.push("");
  if (outputSlotNames.length === 0) {
    parts.push(
      `export const ${upper}_OUTPUT_SLOT_DESCRIPTORS: readonly ${target.prefix}OutputSlotDescriptor[] = [];`,
    );
  } else {
    parts.push(
      `export const ${upper}_OUTPUT_SLOT_DESCRIPTORS: readonly ${target.prefix}OutputSlotDescriptor[] = [\n  ${outputSlotDescriptorsArrayLiteral},\n];`,
    );
  }
  parts.push("");
  if (listenSlotNames.length === 0) {
    parts.push(
      `export const ${upper}_LISTEN_SLOTS: readonly ${target.prefix}ListenSlotDescriptor[] = [];`,
    );
  } else {
    parts.push(
      `export const ${upper}_LISTEN_SLOTS: readonly ${target.prefix}ListenSlotDescriptor[] = [\n  ${listenSlotsArrayLiteral},\n];`,
    );
  }
  parts.push(
    "// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.",
  );
  parts.push(
    `export const ${upper}_KIND_SHAPE_ID = ${JSON.stringify(doc.name)};`,
  );
  parts.push(
    "/** @deprecated Use " + `${upper}_KIND_URI` +
      " for AppSpec kind identity, or " + `${upper}_KIND_SHAPE_ID` +
      " for legacy Shape.id. */",
  );
  parts.push(
    `export const ${upper}_KIND_ID = ${upper}_KIND_SHAPE_ID;`,
  );
  parts.push(
    `export const ${upper}_KIND_NAME = ${JSON.stringify(doc.name)};`,
  );
  parts.push(
    "// Official catalog descriptor URI used in AppSpec kind resolution.",
  );
  parts.push(
    `export const ${upper}_KIND_URI = ${JSON.stringify(doc["@id"])};`,
  );
  parts.push(
    `export const ${upper}_KIND_VERSION = ${JSON.stringify(doc.version)};`,
  );
  if (doc.description !== undefined) {
    parts.push(
      `export const ${upper}_DESCRIPTION = ${JSON.stringify(doc.description)};`,
    );
  }
  parts.push("");
  return parts.join("\n");
}

function renderOutputSlotDescriptor(
  name: string,
  descriptor: OutputSlotDescriptor | undefined,
): string {
  if (!descriptor) {
    throw new Error(`output slot ${name} is missing descriptor metadata`);
  }
  const fields = [
    `name: ${JSON.stringify(name)}`,
    `contract: ${JSON.stringify(descriptor.contract)}`,
  ];
  if (descriptor.exampleMaterialMapping !== undefined) {
    fields.push(
      `exampleMaterialMapping: ${
        renderJsonLiteral(descriptor.exampleMaterialMapping)
      }`,
    );
  }
  return `{\n    ${fields.join(",\n    ")},\n  }`;
}

function renderListenSlotDescriptor(
  name: string,
  descriptor: ListenSlotDescriptor | undefined,
): string {
  if (!descriptor) {
    throw new Error(`listen slot ${name} is missing descriptor metadata`);
  }
  const fields = [`name: ${JSON.stringify(name)}`];
  if (descriptor.accepts !== undefined) {
    fields.push(`accepts: ${renderJsonLiteral(descriptor.accepts)}`);
  }
  if (descriptor.projectionFamilies !== undefined) {
    fields.push(
      `projectionFamilies: ${renderJsonLiteral(descriptor.projectionFamilies)}`,
    );
  }
  if (descriptor.projectionMatrix !== undefined) {
    fields.push(
      `projectionMatrix: ${renderJsonLiteral(descriptor.projectionMatrix)}`,
    );
  }
  if (descriptor.requiredWhenReferencedBy !== undefined) {
    fields.push(
      `requiredWhenReferencedBy: ${
        JSON.stringify(descriptor.requiredWhenReferencedBy)
      }`,
    );
  }
  if (descriptor.minimumAccess !== undefined) {
    fields.push(`minimumAccess: ${JSON.stringify(descriptor.minimumAccess)}`);
  }
  if (descriptor.safeDefaultAccess !== undefined) {
    fields.push(
      `safeDefaultAccess: ${JSON.stringify(descriptor.safeDefaultAccess)}`,
    );
  }
  return `{\n    ${fields.join(",\n    ")},\n  }`;
}

function renderJsonLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("\n", "\n    ");
}

function validateKindDoc(path: string, doc: KindDoc): void {
  if (!doc.name || !doc["@id"]) {
    console.error(`[spec:generate-ts] ${path}: missing @id or name`);
    Deno.exit(1);
  }
  assertNoToolingMetadata(path, doc);
  const uriName = kindNameFromUri(doc["@id"]);
  if (uriName !== doc.name) {
    console.error(
      `[spec:generate-ts] ${path}: @id last segment (${uriName}) must match name (${doc.name})`,
    );
    Deno.exit(1);
  }
  for (const [name, outputSlot] of Object.entries(doc.outputSlots ?? {})) {
    if ("from" in outputSlot) {
      console.error(
        `[spec:generate-ts] ${path}: outputSlots.${name}.from is obsolete; use outputSlots.${name}.exampleMaterialMapping`,
      );
      Deno.exit(1);
    }
    if ("material" in outputSlot) {
      console.error(
        `[spec:generate-ts] ${path}: outputSlots.${name}.material is ambiguous; use outputSlots.${name}.exampleMaterialMapping`,
      );
      Deno.exit(1);
    }
  }
  if ("capabilities" in doc) {
    console.error(
      `[spec:generate-ts] ${path}: capabilities is ambiguous in official descriptors; use capabilityTerms`,
    );
    Deno.exit(1);
  }
  if ("acceptedProjectionFamilies" in doc) {
    console.error(
      `[spec:generate-ts] ${path}: acceptedProjectionFamilies is obsolete; use slot-local listens metadata`,
    );
    Deno.exit(1);
  }
}

function assertNoToolingMetadata(
  path: string,
  value: unknown,
  location = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoToolingMetadata(path, item, `${location}[${index}]`)
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith("x-")) {
      console.error(
        `[spec:generate-ts] ${path}: ${location}.${key} is tooling metadata and is not allowed in public descriptors`,
      );
      Deno.exit(1);
    }
    assertNoToolingMetadata(path, nested, `${location}.${key}`);
  }
}

function generationTarget(
  doc: KindDoc,
  sourceBasename = doc.name,
): { readonly fileBasename: string; readonly prefix: string } {
  return TS_GENERATION_OVERRIDES[sourceBasename] ?? {
    fileBasename: sourceBasename,
    prefix: pascalCase(sourceBasename),
  };
}

function kindNameFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    return segments.at(-1) ?? "";
  } catch {
    return uri.split("/").filter((s) => s.length > 0).at(-1) ?? "";
  }
}

function renderImports(imports: Map<string, Set<string>>): string {
  const entries = Array.from(imports.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([mod, names]) => {
    const sorted = Array.from(names).sort();
    return `import type { ${sorted.join(", ")} } from ${JSON.stringify(mod)};`;
  }).join("\n");
}

function arrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "[]";
  return `[\n  ${
    values.map((value) => JSON.stringify(value)).join(",\n  ")
  },\n]`;
}

function renderOutputs(
  outputs: readonly OutputField[],
  ctx: GeneratorContext,
): string {
  const lines: string[] = [];
  for (const out of outputs) {
    const tsType = outputTypeToTs(out, ctx);
    const optional = out.required ? "" : "?";
    if (out.meaning) {
      lines.push(`  /** ${out.meaning} */`);
    }
    lines.push(`  readonly ${out.name}${optional}: ${tsType};`);
  }
  return `{\n${lines.join("\n")}\n}`;
}

function outputTypeToTs(out: OutputField, ctx: GeneratorContext): string {
  if (out.enum && out.enum.length > 0) {
    return out.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  switch (out.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string[]":
      return "readonly string[]";
    case "object[]":
      if (out.items) {
        const inner = renderTsType(out.items, ctx, pickSingularName(out.name));
        return `readonly ${inner}[]`;
      }
      return "readonly Record<string, unknown>[]";
    default:
      throw new Error(`unsupported output field type: ${out.type}`);
  }
}

function renderObject(
  schema: JsonSchema,
  ctx: GeneratorContext,
  fallbackName: string,
): string {
  if (schema.type !== "object") {
    throw new Error(
      `renderObject: expected type=object, got ${schema.type} (${fallbackName})`,
    );
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const lines: string[] = [];
  const propNames = Object.keys(properties).sort((a, b) => {
    // required first then alphabetical to keep generation order stable
    // while also keeping required-fields-first idiom for readability.
    const ar = required.has(a) ? 0 : 1;
    const br = required.has(b) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });
  for (const propName of propNames) {
    const propSchema = properties[propName];
    const optional = required.has(propName) ? "" : "?";
    const tsType = renderTsType(propSchema, ctx, propName);
    if (propSchema.description) {
      lines.push(`  /** ${propSchema.description} */`);
    }
    lines.push(`  readonly ${propName}${optional}: ${tsType};`);
  }
  if (schema.additionalProperties === true) {
    lines.push("  readonly [extension: string]: unknown;");
  }
  return `{\n${lines.join("\n")}\n}`;
}

function renderNestedInterface(
  nested: NestedType,
  ctx: GeneratorContext,
): string {
  const body = renderObject(nested.source, ctx, nested.name);
  return `export interface ${nested.name} ${body}\n`;
}

/**
 * Render a TS type expression for a JSON Schema node. For nested object
 * schemas, this hoists them to top-level interfaces (registered on
 * ctx.nested) and returns the interface name. Arrays of objects are
 * hoisted as `<Singular>` types by dropping the trailing `s` from simple
 * plural property names.
 */
function renderTsType(
  schema: JsonSchema,
  ctx: GeneratorContext,
  propName: string,
): string {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      if (!schema.items) {
        return "readonly unknown[]";
      }
      const itemName = pickSingularName(propName);
      const inner = renderTsType(schema.items, ctx, itemName);
      return `readonly ${inner}[]`;
    }
    case "object": {
      // If `additionalProperties` is a schema (and no fixed properties),
      // emit a Record type. This is how we map `env: { type: 'object',
      // additionalProperties: { type: 'string' } }`.
      const hasFixedProps = schema.properties &&
        Object.keys(schema.properties).length > 0;
      if (
        !hasFixedProps && typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        const valueType = renderTsType(
          schema.additionalProperties,
          ctx,
          pickSingularName(propName),
        );
        return `Readonly<Record<string, ${valueType}>>`;
      }
      // Otherwise hoist to a named nested interface.
      const nestedName = schema.title ?? pickNestedName(propName, ctx.prefix);
      registerNested(ctx, nestedName, schema);
      return nestedName;
    }
    default:
      throw new Error(
        `renderTsType: unsupported schema for ${propName}: ${
          JSON.stringify(schema)
        }`,
      );
  }
}

function pickNestedName(
  propName: string,
  prefix: string,
): string {
  return `${prefix}${capitalize(propName)}`;
}

function pickSingularName(propName: string): string {
  // simple singularization: drop trailing 's'
  if (propName.endsWith("s") && propName.length > 1) {
    return propName.slice(0, -1);
  }
  return propName;
}

function registerNested(
  ctx: GeneratorContext,
  name: string,
  schema: JsonSchema,
): void {
  if (ctx.nested.some((n) => n.name === name)) return;
  ctx.nested.push({ name, source: schema });
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function pascalCase(value: string): string {
  return value.split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map(capitalize)
    .join("");
}

function camelToUpper(s: string): string {
  return s.replace(/[A-Z]/g, (m, i) => (i === 0 ? m : `_${m}`)).toUpperCase();
}
