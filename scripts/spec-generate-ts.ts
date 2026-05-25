/**
 * Generate TypeScript types from `packages/plugins/spec/kinds/v1/*.jsonld`.
 *
 * For TypeScript helper generation, each official catalog descriptor source
 * file supplies its `spec` shape (= JSON Schema 2020-12 form), `outputs` list,
 * `capabilityTerms` enum, publication envelope
 * (`referenceAliases` / `publications{}`), and optional consumer-slot
 * compatibility metadata (`listens{}`). The generator emits a
 * sibling `packages/plugins/src/kinds/<basename>.generated.ts`
 * containing:
 *
 *   - `<Prefix>Spec` interface (derived from JSON Schema)
 *   - `<Prefix>Outputs` interface (derived from `outputs` array)
 *   - `<Prefix>CapabilityTerm` string union (derived from `capabilityTerms` array)
 *   - `<Prefix>PublicationName` string union (= local publication names)
 *   - `<UPPER>_CAPABILITY_TERMS` / `<UPPER>_OUTPUT_FIELDS` /
 *     `<UPPER>_ALIASES` (referenceAlias suggestions only) /
 *     `<UPPER>_PUBLICATIONS` const arrays
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
import { walk } from "jsr:@std/fs@^1.0.5/walk";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly additionalProperties?: JsonSchema | boolean;
  readonly description?: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly pattern?: string;
  readonly $schema?: string;
}

interface PublicationDescriptor {
  readonly contract: string;
  readonly exampleMaterialMapping?: Record<string, unknown>;
  readonly material?: Record<string, unknown>;
  readonly from?: unknown;
}

interface KindDoc {
  readonly "@context"?: unknown;
  readonly "@id": string;
  readonly "@type"?: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly referenceAliases?: readonly string[];
  readonly publications?: Record<string, PublicationDescriptor>;
  readonly listens?: Record<string, unknown>;
  readonly spec: JsonSchema;
  readonly outputs: readonly OutputField[];
  readonly capabilityTerms: readonly string[];
}

interface OutputField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly meaning?: string;
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

const SPEC_ROOT = fromFileUrl(
  new URL("../packages/plugins/spec/kinds/v1", import.meta.url),
);
const OUTPUT_DIR = fromFileUrl(
  new URL("../packages/plugins/src/kinds", import.meta.url),
);
const HEADER = "// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/" +
  "<basename>.jsonld — DO NOT EDIT.\n" +
  "// Run `deno task spec:generate-ts` to refresh.\n";
const TS_GENERATION_OVERRIDES: Readonly<
  Record<string, { readonly fileBasename: string; readonly prefix: string }>
> = {
  gateway: { fileBasename: "gateway", prefix: "Gateway" },
  "object-store": { fileBasename: "object-store", prefix: "ObjectStore" },
  postgres: { fileBasename: "database-postgres", prefix: "DatabasePostgres" },
  "web-service": { fileBasename: "web-service", prefix: "WebService" },
  worker: { fileBasename: "worker", prefix: "Worker" },
};

if (import.meta.main) {
  const result = await main();
  Deno.exit(result);
}

async function main(): Promise<number> {
  const docs = await loadKindDocs();
  if (docs.length === 0) {
    console.error(`[spec:generate-ts] no .jsonld files found in ${SPEC_ROOT}`);
    return 2;
  }
  const written: string[] = [];
  for (const { doc, sourceBasename } of docs) {
    const ts = generateTs(doc, sourceBasename);
    const target = generationTarget(doc, sourceBasename);
    const outPath = `${OUTPUT_DIR}/${target.fileBasename}.generated.ts`;
    await Deno.writeTextFile(outPath, ts);
    written.push(outPath);
    console.log(
      `[spec:generate-ts] wrote ${outPath} (${doc.name}@${doc.version}, ${
        doc["@id"]
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
    for (const { doc, sourceBasename } of docs) {
      const ts = generateTs(doc, sourceBasename);
      const target = generationTarget(doc, sourceBasename);
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

export function outputDir(): string {
  return OUTPUT_DIR;
}

export interface LoadedKindDoc {
  readonly path: string;
  readonly sourceBasename: string;
  readonly doc: KindDoc;
}

export async function loadKindDocs(): Promise<readonly LoadedKindDoc[]> {
  const out: LoadedKindDoc[] = [];
  for await (
    const entry of walk(SPEC_ROOT, { includeDirs: false, exts: [".jsonld"] })
  ) {
    const text = await Deno.readTextFile(entry.path);
    const doc = JSON.parse(text) as KindDoc;
    validateKindDoc(entry.path, doc);
    out.push({
      path: entry.path,
      sourceBasename: jsonLdBasename(entry.path),
      doc,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
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
  const publicationsTypeName = `${target.prefix}PublicationName`;

  // First pass: collect nested types from spec schema (also generates
  // their inline forms so we know what to emit at top level).
  const specBody = renderObject(doc.spec, ctx, specInterfaceName);
  // After processing spec, ctx.nested contains all nested interfaces.

  const outputsBody = renderOutputs(doc.outputs);

  const capabilityUnion = doc.capabilityTerms.length === 0
    ? "never"
    : doc.capabilityTerms.map((c) => JSON.stringify(c)).join("\n  | ");
  const capabilityArrayLiteral = doc.capabilityTerms
    .map((c) => JSON.stringify(c))
    .join(",\n  ");
  const outputFieldsArrayLiteral = doc.outputs
    .map((o) => JSON.stringify(o.name))
    .join(",\n  ");

  const referenceAliases = doc.referenceAliases ?? [];
  const aliasesArrayLiteral = referenceAliases.length === 0
    ? ""
    : referenceAliases.map((a) => JSON.stringify(a)).join(",\n  ");

  const publicationNames = Object.keys(doc.publications ?? {});
  const publicationsUnion = publicationNames.length === 0
    ? "never"
    : publicationNames.map((p) => JSON.stringify(p)).join("\n  | ");
  const publicationsArrayLiteral = publicationNames.length === 0
    ? ""
    : publicationNames.map((p) => JSON.stringify(p)).join(",\n  ");

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
    `export type ${publicationsTypeName} =\n  | ${publicationsUnion};`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_CAPABILITY_TERMS: readonly ${capabilityTermTypeName}[] = [\n  ${capabilityArrayLiteral},\n];`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_OUTPUT_FIELDS: readonly string[] = [\n  ${outputFieldsArrayLiteral},\n];`,
  );
  parts.push("");
  parts.push(
    "// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.",
  );
  if (referenceAliases.length === 0) {
    parts.push(`export const ${upper}_ALIASES: readonly string[] = [];`);
  } else {
    parts.push(
      `export const ${upper}_ALIASES: readonly string[] = [\n  ${aliasesArrayLiteral},\n];`,
    );
  }
  parts.push("");
  if (publicationNames.length === 0) {
    parts.push(
      `export const ${upper}_PUBLICATIONS: readonly ${publicationsTypeName}[] = [];`,
    );
  } else {
    parts.push(
      `export const ${upper}_PUBLICATIONS: readonly ${publicationsTypeName}[] = [\n  ${publicationsArrayLiteral},\n];`,
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
  for (const [name, publication] of Object.entries(doc.publications ?? {})) {
    if ("from" in publication) {
      console.error(
        `[spec:generate-ts] ${path}: publications.${name}.from is obsolete; use publications.${name}.exampleMaterialMapping`,
      );
      Deno.exit(1);
    }
    if ("material" in publication) {
      console.error(
        `[spec:generate-ts] ${path}: publications.${name}.material is ambiguous; use publications.${name}.exampleMaterialMapping`,
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

function jsonLdBasename(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  return filename.endsWith(".jsonld")
    ? filename.slice(0, -".jsonld".length)
    : filename;
}

function renderImports(imports: Map<string, Set<string>>): string {
  const entries = Array.from(imports.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([mod, names]) => {
    const sorted = Array.from(names).sort();
    return `import type { ${sorted.join(", ")} } from ${JSON.stringify(mod)};`;
  }).join("\n");
}

function renderOutputs(outputs: readonly OutputField[]): string {
  const lines: string[] = [];
  for (const out of outputs) {
    const tsType = outputTypeToTs(out.type);
    const optional = out.required ? "" : "?";
    if (out.meaning) {
      lines.push(`  /** ${out.meaning} */`);
    }
    lines.push(`  readonly ${out.name}${optional}: ${tsType};`);
  }
  return `{\n${lines.join("\n")}\n}`;
}

function outputTypeToTs(t: string): string {
  switch (t) {
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
      return "readonly Record<string, unknown>[]";
    default:
      throw new Error(`unsupported output field type: ${t}`);
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
      const nestedName = pickNestedName(propName, ctx.prefix);
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
