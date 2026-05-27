/**
 * Generate and check portable kind package README files from package-owned
 * descriptors.
 */

interface DenoManifest {
  readonly name?: string;
}

interface JsonSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
}

interface KindDescriptor {
  readonly "@id"?: string;
  readonly name?: string;
  readonly description?: string;
  readonly referenceAliases?: readonly string[];
  readonly spec?: JsonSchema;
  readonly outputSlots?: Record<
    string,
    {
      readonly contract?: string;
    }
  >;
  readonly listens?: Record<
    string,
    {
      readonly accepts?: readonly string[];
      readonly projectionFamilies?: readonly string[];
      readonly projectionMatrix?: Record<string, readonly string[]>;
    }
  >;
  readonly outputs?: readonly {
    readonly name?: string;
    readonly type?: string;
    readonly required?: boolean;
    readonly meaning?: string;
  }[];
  readonly capabilityTerms?: readonly string[];
}

interface ReadmeTarget {
  readonly packageDir: string;
  readonly packageName: string;
  readonly kindName: string;
  readonly kindUri: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly specFields: readonly string[];
  readonly outputSlots: readonly string[];
  readonly listenSlots: readonly string[];
  readonly outputs: readonly string[];
  readonly capabilityTerms: readonly string[];
}

const ROOT = new URL("../", import.meta.url);
const PACKAGES = new URL("packages/", ROOT);

if (import.meta.main) {
  const result = await main(Deno.args);
  Deno.exit(result);
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return 0;
  }
  const check = args.includes("--check");
  const targets = await collectTargets();
  const expected = await formattedReadmes(targets);
  if (check) {
    const stale: string[] = [];
    for (const target of targets) {
      const path = new URL(`${target.packageDir}/README.md`, PACKAGES);
      const actual = await readOptionalText(path);
      if (actual !== expected.get(target.packageDir)) {
        stale.push(target.packageDir);
      }
    }
    if (stale.length > 0) {
      for (const packageDir of stale) {
        console.error(`[portable-readme] ${packageDir}/README.md is stale`);
      }
      return 1;
    }
    console.log(`[portable-readme] OK - ${targets.length} README file(s)`);
    return 0;
  }

  const written: string[] = [];
  for (const target of targets) {
    const path = new URL(`${target.packageDir}/README.md`, PACKAGES);
    const source = expected.get(target.packageDir);
    if (source === undefined) {
      throw new Error(`${target.packageDir}: missing generated README`);
    }
    await Deno.writeTextFile(path, source);
    written.push(path.pathname);
    console.log(`[portable-readme] wrote ${target.packageDir}/README.md`);
  }
  await formatFiles(written);
  return 0;
}

async function collectTargets(): Promise<readonly ReadmeTarget[]> {
  const targets: ReadmeTarget[] = [];
  for await (const entry of Deno.readDir(PACKAGES)) {
    if (!entry.isDirectory || !entry.name.startsWith("kind-")) continue;
    const packageRoot = new URL(`${entry.name}/`, PACKAGES);
    const manifest = await readJson<DenoManifest>(
      new URL("deno.json", packageRoot),
    );
    const descriptor = await readJson<KindDescriptor>(
      new URL("spec/kind.jsonld", packageRoot),
    );
    const required = new Set(descriptor.spec?.required ?? []);
    targets.push({
      packageDir: entry.name,
      packageName: requireString(manifest.name, `${entry.name}/deno.json name`),
      kindName: requireString(descriptor.name, `${entry.name}/spec name`),
      kindUri: requireString(descriptor["@id"], `${entry.name}/spec @id`),
      description: requireString(
        descriptor.description,
        `${entry.name}/spec description`,
      ),
      aliases: [...(descriptor.referenceAliases ?? [])].sort(),
      specFields: Object.entries(descriptor.spec?.properties ?? {})
        .map(([name, schema]) =>
          `\`${name}\`${required.has(name) ? " (required)" : ""}: \`${
            schemaSummary(schema)
          }\`${schema.description ? ` - ${schema.description}` : ""}`
        )
        .sort(),
      outputSlots: Object.entries(descriptor.outputSlots ?? {})
        .map(([name, outputSlot]) =>
          `\`${name}\` as \`${outputSlot.contract ?? "unknown"}\``
        )
        .sort(),
      listenSlots: Object.entries(descriptor.listens ?? {})
        .map(([name, slot]) => renderListenSlot(name, slot))
        .sort(),
      outputs: (descriptor.outputs ?? [])
        .map((output) =>
          `\`${output.name ?? "unknown"}\`${
            output.required ? " (required)" : ""
          }: \`${output.type ?? "unknown"}\`${
            output.meaning ? ` - ${output.meaning}` : ""
          }`
        ),
      capabilityTerms: [...(descriptor.capabilityTerms ?? [])].sort().map((
        term,
      ) => `\`${term}\``),
    });
  }
  return targets.sort((left, right) =>
    left.packageDir.localeCompare(right.packageDir)
  );
}

async function formattedReadmes(
  targets: readonly ReadmeTarget[],
): Promise<ReadonlyMap<string, string>> {
  const tmp = await Deno.makeTempDir({ prefix: "takosumi-portable-readme-" });
  try {
    const paths: string[] = [];
    const pathByPackage = new Map<string, string>();
    for (const target of targets) {
      const path = `${tmp}/${target.packageDir}.md`;
      await Deno.writeTextFile(path, renderReadme(target));
      paths.push(path);
      pathByPackage.set(target.packageDir, path);
    }
    await formatFiles(paths);
    const out = new Map<string, string>();
    for (const [packageDir, path] of pathByPackage.entries()) {
      out.set(packageDir, await Deno.readTextFile(path));
    }
    return out;
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

function renderReadme(target: ReadmeTarget): string {
  const source = `# ${target.packageName}

${target.description}

## Kind Identity

- Kind name: \`${target.kindName}\`
- Kind URI: \`${target.kindUri}\`
- Package source: \`takosumi/packages/${target.packageDir}\`
- Descriptor source: \`spec/kind.jsonld\`
- Suggested aliases: ${inlineList(target.aliases)}

## Spec Fields

${bulletList(target.specFields)}

## Output Slot Contract

${bulletList(target.outputSlots)}

## Listen Slots

${bulletList(target.listenSlots)}

## Outputs

${bulletList(target.outputs)}

## Capability Terms

${bulletList(target.capabilityTerms)}

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
`;
  assertBalancedInlineCode(source, target.packageDir);
  return source;
}

function schemaSummary(schema: JsonSchema): string {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  return schema.type ?? "unknown";
}

function renderListenSlot(
  name: string,
  slot: {
    readonly accepts?: readonly string[];
    readonly projectionFamilies?: readonly string[];
    readonly projectionMatrix?: Record<string, readonly string[]>;
  },
): string {
  const base = `\`${name}\`: accepts ${inlineList(slot.accepts ?? [])}`;
  if (slot.projectionMatrix === undefined) {
    return `${base}; projections ${inlineList(slot.projectionFamilies ?? [])}`;
  }
  const matrix = Object.entries(slot.projectionMatrix)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outputType, projections]) =>
      `\`${outputType}\` -> ${inlineList(projections)}`
    )
    .join("; ");
  return `${base}; projection matrix ${matrix}`;
}

function bulletList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${value}`).join("\n");
}

function inlineList(values: readonly string[]): string {
  if (values.length === 0) return "`none`";
  return values.map((value) => `\`${value}\``).join(", ");
}

function assertBalancedInlineCode(source: string, packageDir: string): void {
  for (const [index, line] of source.split("\n").entries()) {
    const tickCount = [...line].filter((char) => char === "`").length;
    if (tickCount % 2 !== 0) {
      throw new Error(
        `${packageDir}/README.md line ${index + 1} has unbalanced inline code`,
      );
    }
  }
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

async function readOptionalText(url: URL): Promise<string> {
  try {
    return await Deno.readTextFile(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} must be a non-empty string`);
}

async function formatFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const command = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--quiet", ...paths],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      `deno fmt failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

function printUsage(): void {
  console.log(
    `Usage: deno run --allow-read --allow-write --allow-run scripts/portable-package-readme.ts [--check]

Options:
  --check  Verify README files without rewriting them.
`,
  );
}
