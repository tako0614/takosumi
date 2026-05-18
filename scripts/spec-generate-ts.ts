/**
 * Generate TypeScript types from `spec/contexts/kinds/v1/*.jsonld`.
 *
 * Each kind document is the **canonical source of truth** for its
 * `spec` shape (= JSON Schema 2020-12 form), `outputs` list and
 * `capabilities` enum. The generator emits a sibling
 * `packages/plugins/src/kinds/<basename>.generated.ts` containing:
 *
 *   - `<Prefix>Spec` interface (derived from JSON Schema)
 *   - `<Prefix>Outputs` interface (derived from `outputs` array)
 *   - `<Prefix>Capability` string union (derived from `capabilities` array)
 *   - `<UPPER>_CAPABILITIES` / `<UPPER>_OUTPUT_FIELDS` const arrays
 *   - `<UPPER>_KIND_ID` / `<UPPER>_KIND_VERSION` / `<UPPER>_DESCRIPTION`
 *
 * Hand-written sibling `<basename>.ts` re-exports the generated types and
 * adds the `Shape` descriptor + runtime validators (which are NOT
 * generated, to keep validation diagnostics human-curated).
 *
 * Extension keywords used in the JSON Schema:
 *
 *   - `x-ts` (top-level): `{ fileBasename, prefix, shapeId }` — controls
 *     TS naming. `prefix` is used for all derived interface names;
 *     `fileBasename` is the generated TS file basename.
 *   - `x-ts-name` (per nested schema): explicit interface name suffix
 *     (e.g. `Redirect` → `CustomDomainRedirect`).
 *   - `x-ts-type` (per schema): `{ import: <module>, name: <type> }`
 *     overrides the auto-generated type with an imported one.
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
  readonly "x-ts-name"?: string;
  readonly "x-ts-type"?: { readonly import: string; readonly name: string };
  readonly $schema?: string;
}

interface KindDoc {
  readonly "@context"?: unknown;
  readonly "@id"?: string;
  readonly "@type"?: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly "x-ts": {
    readonly fileBasename: string;
    readonly prefix: string;
    readonly shapeId: string;
  };
  readonly spec: JsonSchema;
  readonly outputs: readonly OutputField[];
  readonly capabilities: readonly string[];
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
  new URL("../spec/contexts/kinds/v1", import.meta.url),
);
const OUTPUT_DIR = fromFileUrl(
  new URL("../packages/plugins/src/kinds", import.meta.url),
);
const HEADER = "// AUTO-GENERATED FROM spec/contexts/kinds/v1/" +
  "<basename>.jsonld — DO NOT EDIT.\n" +
  "// Run `deno task spec:generate-ts` to refresh.\n";

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
  for (const { doc } of docs) {
    const ts = generateTs(doc);
    const outPath = `${OUTPUT_DIR}/${doc["x-ts"].fileBasename}.generated.ts`;
    await Deno.writeTextFile(outPath, ts);
    written.push(outPath);
    console.log(
      `[spec:generate-ts] wrote ${outPath} (${
        doc["x-ts"].shapeId
      }@${doc.version})`,
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
    for (const { doc } of docs) {
      const ts = generateTs(doc);
      const outPath = `${tmpDir}/${doc["x-ts"].fileBasename}.generated.ts`;
      await Deno.writeTextFile(outPath, ts);
      paths.push(outPath);
      map.set(doc["x-ts"].fileBasename, outPath);
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
  readonly doc: KindDoc;
}

export async function loadKindDocs(): Promise<readonly LoadedKindDoc[]> {
  const out: LoadedKindDoc[] = [];
  for await (
    const entry of walk(SPEC_ROOT, { includeDirs: false, exts: [".jsonld"] })
  ) {
    const text = await Deno.readTextFile(entry.path);
    const doc = JSON.parse(text) as KindDoc;
    if (!doc.name || !doc["x-ts"]) {
      console.error(`[spec:generate-ts] ${entry.path}: missing name or x-ts`);
      Deno.exit(1);
    }
    out.push({ path: entry.path, doc });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function generateTs(doc: KindDoc): string {
  const ctx: GeneratorContext = {
    prefix: doc["x-ts"].prefix,
    nested: [],
    imports: new Map(),
  };
  const upper = camelToUpper(doc["x-ts"].prefix);
  const specInterfaceName = `${doc["x-ts"].prefix}Spec`;
  const outputsInterfaceName = `${doc["x-ts"].prefix}Outputs`;
  const capabilityTypeName = `${doc["x-ts"].prefix}Capability`;

  // First pass: collect nested types from spec schema (also generates
  // their inline forms so we know what to emit at top level).
  const specBody = renderObject(doc.spec, ctx, specInterfaceName);
  // After processing spec, ctx.nested contains all nested interfaces.

  const outputsBody = renderOutputs(doc.outputs);

  const capabilityUnion = doc.capabilities.length === 0
    ? "never"
    : doc.capabilities.map((c) => JSON.stringify(c)).join("\n  | ");
  const capabilityArrayLiteral = doc.capabilities
    .map((c) => JSON.stringify(c))
    .join(",\n  ");
  const outputFieldsArrayLiteral = doc.outputs
    .map((o) => JSON.stringify(o.name))
    .join(",\n  ");

  const importLines = renderImports(ctx.imports);
  const nestedBlocks = ctx.nested
    .map((n) => renderNestedInterface(n, ctx))
    .join("\n");

  const basename = doc["x-ts"].fileBasename;
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
  parts.push(`export type ${capabilityTypeName} =\n  | ${capabilityUnion};`);
  parts.push("");
  parts.push(
    `export const ${upper}_CAPABILITIES: readonly ${capabilityTypeName}[] = [\n  ${capabilityArrayLiteral},\n];`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_OUTPUT_FIELDS: readonly string[] = [\n  ${outputFieldsArrayLiteral},\n];`,
  );
  parts.push("");
  parts.push(
    `export const ${upper}_KIND_ID = ${JSON.stringify(doc["x-ts"].shapeId)};`,
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
 * hoisted as `<Singular>` types (using `x-ts-name` override on `items`
 * when present, otherwise dropping the trailing 's' from the property
 * name).
 */
function renderTsType(
  schema: JsonSchema,
  ctx: GeneratorContext,
  propName: string,
): string {
  // x-ts-type override: import the named type from an external module.
  if (schema["x-ts-type"]) {
    const { import: mod, name } = schema["x-ts-type"];
    addImport(ctx, mod, name);
    return name;
  }
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
      const itemName = pickSingularName(propName, schema.items);
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
          propName,
        );
        return `Readonly<Record<string, ${valueType}>>`;
      }
      // Otherwise hoist to a named nested interface.
      const nestedName = pickNestedName(propName, schema, ctx.prefix);
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

function addImport(
  ctx: GeneratorContext,
  module: string,
  name: string,
): void {
  let set = ctx.imports.get(module);
  if (!set) {
    set = new Set();
    ctx.imports.set(module, set);
  }
  set.add(name);
}

function pickNestedName(
  propName: string,
  schema: JsonSchema,
  prefix: string,
): string {
  const explicit = schema["x-ts-name"];
  if (explicit) return `${prefix}${explicit}`;
  return `${prefix}${capitalize(propName)}`;
}

function pickSingularName(propName: string, items: JsonSchema): string {
  if (items["x-ts-name"]) return items["x-ts-name"];
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

function camelToUpper(s: string): string {
  return s.replace(/[A-Z]/g, (m, i) => (i === 0 ? m : `_${m}`)).toUpperCase();
}
