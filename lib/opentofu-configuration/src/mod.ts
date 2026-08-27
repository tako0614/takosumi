import { canonicalProviderSource } from "../../../contract/provider-env-rules.ts";

export interface OpenTofuSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface OpenTofuProviderRequirement {
  readonly source: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
  readonly version?: string;
}

export type OpenTofuConfigurationDiagnosticCode =
  | "configuration_missing"
  | "file_limit_exceeded"
  | "file_too_large"
  | "total_bytes_exceeded"
  | "hcl_incomplete"
  | "json_invalid"
  | "json_semantics_unsupported"
  | "provider_declaration_incomplete"
  | "local_module_source_incomplete"
  | "local_module_source_escapes"
  | "local_module_source_missing"
  | "module_directory_unreadable"
  | "source_path_invalid"
  | "duplicate_source_file"
  | "dependency_lock_incomplete";

export interface OpenTofuConfigurationDiagnostic {
  readonly code: OpenTofuConfigurationDiagnosticCode;
  readonly path: string;
  readonly message: string;
  /** Fatal diagnostics mean the provider set is not complete. */
  readonly fatal: boolean;
}

export interface OpenTofuConfigurationGraph {
  readonly complete: boolean;
  readonly files: readonly OpenTofuSourceFile[];
  readonly requirements: readonly OpenTofuProviderRequirement[];
  readonly diagnostics: readonly OpenTofuConfigurationDiagnostic[];
}

export interface OpenTofuProviderLockObservation {
  readonly complete: boolean;
  readonly sources: readonly string[];
  readonly diagnostics: readonly OpenTofuConfigurationDiagnostic[];
}

export interface OpenTofuConfigurationLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_OPENTOFU_CONFIGURATION_LIMITS = {
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
} as const satisfies OpenTofuConfigurationLimits;

export interface OpenTofuModuleDirectory {
  /** Whether the physical directory exists and was read completely. */
  readonly exists: boolean;
  readonly files: readonly OpenTofuSourceFile[];
  readonly diagnostic?: OpenTofuConfigurationDiagnostic;
}

export interface OpenTofuConfigurationLoaderInput {
  readonly selectedModuleDirectory?: string;
  readonly loadModuleDirectory: (
    directory: string,
  ) => Promise<OpenTofuModuleDirectory>;
  readonly limits?: OpenTofuConfigurationLimits;
}

export interface OpenTofuConfigurationFilesInput {
  readonly selectedModuleDirectory?: string;
  readonly files: readonly OpenTofuSourceFile[];
  readonly directories?: readonly string[];
  readonly limits?: OpenTofuConfigurationLimits;
}

export function openTofuConfigurationFileKind(
  path: string,
): "hcl" | "json" | undefined {
  return path.endsWith(".tf.json") || path.endsWith(".tofu.json")
    ? "json"
    : path.endsWith(".tf") || path.endsWith(".tofu")
      ? "hcl"
      : undefined;
}

/** Provider package sources observed after credential-free `tofu init`. */
export function parseOpenTofuProviderLockObservation(
  text: string,
  path = ".terraform.lock.hcl",
): OpenTofuProviderLockObservation {
  const masked = maskHclCommentsAndHeredocs(text);
  const blocks = masked.complete
    ? topLevelBlocks(masked.text, "provider", 1)
    : { blocks: [], complete: false };
  const sources = new Set<string>();
  let complete = masked.complete && blocks.complete;
  for (const block of blocks.blocks) {
    const canonical = canonicalProviderAddress(block.labels[0] ?? "");
    if (!canonical) {
      complete = false;
      continue;
    }
    sources.add(canonical);
  }
  return {
    complete,
    sources: [...sources].sort(compareCodePoints),
    diagnostics: complete
      ? []
      : [
          {
            code: "dependency_lock_incomplete",
            path,
            message: "The OpenTofu dependency lock provider set could not be parsed exactly.",
            fatal: true,
          },
        ],
  };
}

/**
 * Compile one selected module plus only its reachable local child modules from
 * a bounded in-memory source listing. Unselected sibling directories never
 * contribute requirements or consume the graph's file/byte limits.
 */
export function compileOpenTofuConfigurationGraph(
  input: OpenTofuConfigurationFilesInput,
): OpenTofuConfigurationGraph {
  const selected = normalizeDirectory(input.selectedModuleDirectory ?? ".");
  const byDirectory = new Map<string, OpenTofuSourceFile[]>();
  const inputDiagnostics: OpenTofuConfigurationDiagnostic[] = [];
  const directories = new Set(
    (input.directories ?? []).map((directory) => normalizeDirectory(directory)),
  );
  directories.add(selected);
  for (const file of input.files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeFilePath(file.path);
    } catch {
      inputDiagnostics.push({
        code: "source_path_invalid",
        path: file.path,
        message: "OpenTofu source file path must stay relative to the source records.",
        fatal: true,
      });
      continue;
    }
    const kind = openTofuConfigurationFileKind(normalizedPath);
    if (!kind) continue;
    const directory = dirname(normalizedPath);
    const entries = byDirectory.get(directory) ?? [];
    entries.push({ path: normalizedPath, text: file.text });
    byDirectory.set(directory, entries);
    directories.add(directory);
  }
  const compiler = new ConfigurationGraphCompiler(
    selected,
    input.limits ?? DEFAULT_OPENTOFU_CONFIGURATION_LIMITS,
  );
  compiler.addDiagnostics(inputDiagnostics);
  while (compiler.nextDirectory() !== undefined) {
    const directory = compiler.currentDirectory!;
    compiler.consume({
      exists: directories.has(directory) || byDirectory.has(directory),
      files: byDirectory.get(directory) ?? [],
    });
  }
  return compiler.finish();
}

/** Same compiler with an injected directory loader for the runner filesystem. */
export async function compileOpenTofuConfigurationGraphFromLoader(
  input: OpenTofuConfigurationLoaderInput,
): Promise<OpenTofuConfigurationGraph> {
  const compiler = new ConfigurationGraphCompiler(
    normalizeDirectory(input.selectedModuleDirectory ?? "."),
    input.limits ?? DEFAULT_OPENTOFU_CONFIGURATION_LIMITS,
  );
  while (compiler.nextDirectory() !== undefined) {
    const directory = compiler.currentDirectory!;
    let loaded: OpenTofuModuleDirectory;
    try {
      loaded = await input.loadModuleDirectory(directory);
    } catch {
      loaded = {
        exists: false,
        files: [],
        diagnostic: {
          code: "module_directory_unreadable",
          path: directory,
          message: `OpenTofu module directory ${directory} could not be read completely.`,
          fatal: true,
        },
      };
    }
    compiler.consume(loaded);
  }
  return compiler.finish();
}

interface ProviderDeclaration {
  readonly source: string;
  readonly moduleLocalName: string;
  readonly childAliases: readonly string[];
  readonly version?: string;
}

interface CompiledDirectory {
  readonly declarations: readonly ProviderDeclaration[];
  readonly localModuleSources: readonly Readonly<{
    source: string;
    path: string;
  }>[];
  readonly diagnostics: readonly OpenTofuConfigurationDiagnostic[];
}

class ConfigurationGraphCompiler {
  readonly #selected: string;
  readonly #limits: OpenTofuConfigurationLimits;
  readonly #queue: string[];
  readonly #queued = new Set<string>();
  readonly #visited = new Set<string>();
  readonly #files: OpenTofuSourceFile[] = [];
  readonly #declarations: ProviderDeclaration[] = [];
  readonly #diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  #totalBytes = 0;
  currentDirectory: string | undefined;

  constructor(selected: string, limits: OpenTofuConfigurationLimits) {
    assertLimits(limits);
    this.#selected = selected;
    this.#limits = limits;
    this.#queue = [selected];
    this.#queued.add(selected);
  }

  nextDirectory(): string | undefined {
    const next = this.#queue.shift();
    this.currentDirectory = next;
    return next;
  }

  addDiagnostics(
    diagnostics: readonly OpenTofuConfigurationDiagnostic[],
  ): void {
    this.#diagnostics.push(...diagnostics);
  }

  consume(directory: OpenTofuModuleDirectory): void {
    const current = this.currentDirectory;
    if (current === undefined || this.#visited.has(current)) {
      throw new Error("OpenTofu graph compiler directory protocol violated");
    }
    this.#visited.add(current);
    if (directory.diagnostic) this.#diagnostics.push(directory.diagnostic);
    if (!directory.exists) {
      if (!directory.diagnostic) {
        this.#diagnostics.push({
          code: "local_module_source_missing",
          path: current,
          message: `Reachable local OpenTofu module ${current} is missing.`,
          fatal: true,
        });
      }
      return;
    }
    const files: OpenTofuSourceFile[] = [];
    const paths = new Set<string>();
    for (const file of directory.files) {
      let normalizedPath: string;
      try {
        normalizedPath = normalizeFilePath(file.path);
      } catch {
        this.#diagnostics.push({
          code: "source_path_invalid",
          path: file.path,
          message: `Module loader returned an invalid source path for directory ${current}.`,
          fatal: true,
        });
        continue;
      }
      if (openTofuConfigurationFileKind(normalizedPath) === undefined) continue;
      if (paths.has(normalizedPath)) {
        this.#diagnostics.push({
          code: "duplicate_source_file",
          path: normalizedPath,
          message: `Module loader returned ${normalizedPath} more than once.`,
          fatal: true,
        });
        continue;
      }
      paths.add(normalizedPath);
      files.push({ path: normalizedPath, text: file.text });
    }
    files.sort((left, right) => compareCodePoints(left.path, right.path));
    if (current === this.#selected && files.length === 0) {
      this.#diagnostics.push({
        code: "configuration_missing",
        path: current,
        message: "The selected directory has no OpenTofu configuration files.",
        fatal: true,
      });
    }
    for (const file of files) {
      if (dirname(file.path) !== current) {
        this.#diagnostics.push({
          code: "module_directory_unreadable",
          path: file.path,
          message: `Module loader returned ${file.path} for directory ${current}.`,
          fatal: true,
        });
        continue;
      }
      const bytes = new TextEncoder().encode(file.text).byteLength;
      if (this.#files.length >= this.#limits.maxFiles) {
        this.#diagnostics.push({
          code: "file_limit_exceeded",
          path: file.path,
          message: `Reachable OpenTofu configuration exceeds ${this.#limits.maxFiles} files.`,
          fatal: true,
        });
        return;
      }
      if (bytes > this.#limits.maxFileBytes) {
        this.#diagnostics.push({
          code: "file_too_large",
          path: file.path,
          message: `OpenTofu configuration file ${file.path} exceeds ${this.#limits.maxFileBytes} bytes.`,
          fatal: true,
        });
        return;
      }
      if (this.#totalBytes + bytes > this.#limits.maxTotalBytes) {
        this.#diagnostics.push({
          code: "total_bytes_exceeded",
          path: file.path,
          message: `Reachable OpenTofu configuration exceeds ${this.#limits.maxTotalBytes} bytes.`,
          fatal: true,
        });
        return;
      }
      this.#files.push(file);
      this.#totalBytes += bytes;
    }
    const compiled = compileModuleDirectory(files);
    this.#declarations.push(...compiled.declarations);
    this.#diagnostics.push(...compiled.diagnostics);
    for (const local of compiled.localModuleSources) {
      const resolved = resolveLocalModuleDirectory(current, local.source);
      if (resolved === undefined) {
        this.#diagnostics.push({
          code: "local_module_source_escapes",
          path: local.path,
          message: `Local module source ${local.source} escapes the selected module tree.`,
          fatal: true,
        });
        continue;
      }
      if (!this.#queued.has(resolved)) {
        this.#queued.add(resolved);
        this.#queue.push(resolved);
      }
    }
    this.#queue.sort(compareCodePoints);
  }

  finish(): OpenTofuConfigurationGraph {
    return {
      complete: !this.#diagnostics.some((diagnostic) => diagnostic.fatal),
      files: [...this.#files].sort((left, right) =>
        compareCodePoints(left.path, right.path),
      ),
      requirements: mergeProviderDeclarations(this.#declarations),
      diagnostics: [...this.#diagnostics].sort(
        (left, right) =>
          compareCodePoints(left.path, right.path) ||
          compareCodePoints(left.code, right.code) ||
          compareCodePoints(left.message, right.message),
      ),
    };
  }
}

function compileModuleDirectory(
  files: readonly OpenTofuSourceFile[],
): CompiledDirectory {
  const declarations: ProviderDeclaration[] = [];
  const localModuleSources: Array<{ source: string; path: string }> = [];
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  for (const file of files) {
    const kind = openTofuConfigurationFileKind(file.path);
    if (kind === "json") {
      const compiled = compileJsonFile(file);
      declarations.push(...compiled.declarations);
      localModuleSources.push(...compiled.localModuleSources);
      diagnostics.push(...compiled.diagnostics);
      continue;
    }
    if (kind === "hcl") {
      const compiled = compileHclFile(file);
      declarations.push(...compiled.declarations);
      localModuleSources.push(...compiled.localModuleSources);
      diagnostics.push(...compiled.diagnostics);
    }
  }
  return { declarations, localModuleSources, diagnostics };
}

function compileHclFile(file: OpenTofuSourceFile): CompiledDirectory {
  const declarations: ProviderDeclaration[] = [];
  const localModuleSources: Array<{ source: string; path: string }> = [];
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  const masked = maskHclCommentsAndHeredocs(file.text);
  if (!masked.complete) {
    diagnostics.push({
      code: "hcl_incomplete",
      path: file.path,
      message: "HCL comments, strings, heredocs, or delimiters are incomplete.",
      fatal: true,
    });
    return { declarations, localModuleSources, diagnostics };
  }
  const terraform = topLevelBlocks(masked.text, "terraform", 0);
  const modules = topLevelBlocks(masked.text, "module", 1);
  if (!terraform.complete || !modules.complete) {
    diagnostics.push({
      code: "hcl_incomplete",
      path: file.path,
      message: "HCL block structure could not be parsed completely.",
      fatal: true,
    });
  }
  for (const terraformBlock of terraform.blocks) {
    const required = topLevelBlocks(
      terraformBlock.body,
      "required_providers",
      0,
    );
    if (!required.complete) {
      diagnostics.push({
        code: "hcl_incomplete",
        path: file.path,
        message: "required_providers block structure is incomplete.",
        fatal: true,
      });
    }
    for (const block of required.blocks) {
      const assignments = topLevelAssignments(block.body);
      if (!assignments.complete) {
        diagnostics.push({
          code: "provider_declaration_incomplete",
          path: file.path,
          message: "A required_providers entry could not be parsed exactly.",
          fatal: true,
        });
      }
      for (const assignment of assignments.assignments) {
        const declaration = providerDeclarationFromHclAssignment(assignment);
        if (!declaration) {
          diagnostics.push({
            code: "provider_declaration_incomplete",
            path: file.path,
            message: `Provider ${assignment.name} could not be derived exactly.`,
            fatal: true,
          });
          continue;
        }
        declarations.push(declaration);
      }
    }
  }
  for (const moduleBlock of modules.blocks) {
    const assignments = topLevelAssignments(moduleBlock.body);
    if (!assignments.complete) {
      diagnostics.push({
        code: "local_module_source_incomplete",
        path: file.path,
        message: `Module ${moduleBlock.labels[0] ?? "<unknown>"} could not be parsed exactly.`,
        fatal: true,
      });
      continue;
    }
    const source = assignments.assignments.find(
      (assignment) => assignment.name === "source",
    );
    if (!source) {
      diagnostics.push({
        code: "local_module_source_incomplete",
        path: file.path,
        message: `Module ${moduleBlock.labels[0] ?? "<unknown>"} has no source attribute.`,
        fatal: true,
      });
      continue;
    }
    const value = literalString(source.expression);
    if (value === undefined) {
      diagnostics.push({
        code: "local_module_source_incomplete",
        path: file.path,
        message: `Module ${moduleBlock.labels[0] ?? "<unknown>"} source is not a static string.`,
        fatal: true,
      });
      continue;
    }
    if (isLocalModuleSource(value)) {
      localModuleSources.push({ source: value, path: file.path });
    }
  }
  return { declarations, localModuleSources, diagnostics };
}

function providerDeclarationFromHclAssignment(
  assignment: Assignment,
): ProviderDeclaration | undefined {
  const localName = assignment.name;
  if (!PROVIDER_LOCAL_NAME.test(localName)) return undefined;
  let source = `hashicorp/${localName}`;
  let version: string | undefined;
  let childAliases: readonly string[] = [];
  const expression = assignment.expression.trim();
  if (expression.startsWith("{")) {
    if (!expression.endsWith("}")) return undefined;
    const parsedAttributes = topLevelAssignments(expression.slice(1, -1));
    if (!parsedAttributes.complete) return undefined;
    const attributes = parsedAttributes.assignments;
    if (
      attributes.some(
        (entry) =>
          entry.name !== "source" &&
          entry.name !== "version" &&
          entry.name !== "configuration_aliases",
      )
    ) {
      return undefined;
    }
    const sourceAttribute = attributes.find((entry) => entry.name === "source");
    if (sourceAttribute) {
      const literal = literalString(sourceAttribute.expression);
      if (literal === undefined) return undefined;
      source = literal;
    }
    const versionAttribute = attributes.find(
      (entry) => entry.name === "version",
    );
    if (versionAttribute) {
      const constraint = literalString(versionAttribute.expression);
      if (constraint === undefined) return undefined;
      version = exactProviderVersion(constraint);
    }
    const aliasesAttribute = attributes.find(
      (entry) => entry.name === "configuration_aliases",
    );
    if (aliasesAttribute) {
      const aliases = parseAliases(aliasesAttribute.expression, localName);
      if (aliases === undefined) return undefined;
      childAliases = aliases;
    }
  } else {
    const constraint = literalString(expression);
    if (constraint === undefined) return undefined;
    version = exactProviderVersion(constraint);
  }
  const canonical = canonicalProviderAddress(source);
  if (!canonical) return undefined;
  return {
    source: canonical,
    moduleLocalName: localName,
    childAliases,
    ...(version === undefined ? {} : { version }),
  };
}

function compileJsonFile(file: OpenTofuSourceFile): CompiledDirectory {
  const declarations: ProviderDeclaration[] = [];
  const localModuleSources: Array<{ source: string; path: string }> = [];
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  let value: unknown;
  try {
    value = JSON.parse(file.text) as unknown;
  } catch {
    diagnostics.push({
      code: "json_invalid",
      path: file.path,
      message: "OpenTofu JSON configuration is not valid JSON.",
      fatal: true,
    });
    return { declarations, localModuleSources, diagnostics };
  }
  if (!isRecord(value)) {
    diagnostics.push({
      code: "json_invalid",
      path: file.path,
      message: "OpenTofu JSON configuration root must be an object.",
      fatal: true,
    });
    return { declarations, localModuleSources, diagnostics };
  }
  diagnostics.push({
    code: "json_semantics_unsupported",
    path: file.path,
    message:
      "Provider identities are derived from JSON, but full compatibility semantics for JSON blocks are not yet classified.",
    fatal: false,
  });
  for (const terraform of blockObjects(value.terraform)) {
    for (const required of blockObjects(terraform.required_providers)) {
      for (const [localName, specification] of Object.entries(required)) {
        const declaration = providerDeclarationFromJson(
          localName,
          specification,
        );
        if (!declaration) {
          diagnostics.push({
            code: "provider_declaration_incomplete",
            path: file.path,
            message: `Provider ${localName} could not be derived exactly from JSON.`,
            fatal: true,
          });
          continue;
        }
        declarations.push(declaration);
      }
    }
  }
  for (const modules of blockObjects(value.module)) {
    for (const [name, body] of Object.entries(modules)) {
      for (const moduleBody of blockObjects(body)) {
        if (!("source" in moduleBody)) {
          diagnostics.push({
            code: "local_module_source_incomplete",
            path: file.path,
            message: `Module ${name} has no source attribute.`,
            fatal: true,
          });
          continue;
        }
        if (typeof moduleBody.source !== "string" || hasTemplate(moduleBody.source)) {
          diagnostics.push({
            code: "local_module_source_incomplete",
            path: file.path,
            message: `Module ${name} source is not a static JSON string.`,
            fatal: true,
          });
          continue;
        }
        if (isLocalModuleSource(moduleBody.source)) {
          localModuleSources.push({ source: moduleBody.source, path: file.path });
        }
      }
    }
  }
  return { declarations, localModuleSources, diagnostics };
}

function providerDeclarationFromJson(
  localName: string,
  specification: unknown,
): ProviderDeclaration | undefined {
  if (!PROVIDER_LOCAL_NAME.test(localName)) return undefined;
  let source = `hashicorp/${localName}`;
  let version: string | undefined;
  let childAliases: readonly string[] = [];
  if (typeof specification === "string") {
    if (hasTemplate(specification)) return undefined;
    version = exactProviderVersion(specification);
  } else if (isRecord(specification)) {
    if (
      Object.keys(specification).some(
        (key) =>
          key !== "source" &&
          key !== "version" &&
          key !== "configuration_aliases",
      )
    ) {
      return undefined;
    }
    if ("source" in specification) {
      if (
        typeof specification.source !== "string" ||
        hasTemplate(specification.source)
      ) {
        return undefined;
      }
      source = specification.source;
    }
    if (
      typeof specification.version === "string" &&
      !hasTemplate(specification.version)
    ) {
      version = exactProviderVersion(specification.version);
    } else if (
      specification.version !== undefined &&
      typeof specification.version !== "string"
    ) {
      return undefined;
    }
    if (specification.configuration_aliases !== undefined) {
      const aliases = parseJsonAliases(
        specification.configuration_aliases,
        localName,
      );
      if (aliases === undefined) return undefined;
      childAliases = aliases;
    }
  } else {
    return undefined;
  }
  const canonical = canonicalProviderAddress(source);
  if (!canonical) return undefined;
  return {
    source: canonical,
    moduleLocalName: localName,
    childAliases,
    ...(version === undefined ? {} : { version }),
  };
}

function mergeProviderDeclarations(
  declarations: readonly ProviderDeclaration[],
): readonly OpenTofuProviderRequirement[] {
  const exactVersionsBySource = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    if (declaration.version === undefined) continue;
    const versions = exactVersionsBySource.get(declaration.source) ?? new Set();
    versions.add(declaration.version);
    exactVersionsBySource.set(declaration.source, versions);
  }
  const requirements = new Map<string, OpenTofuProviderRequirement>();
  for (const declaration of declarations) {
    for (const childAlias of [undefined, ...declaration.childAliases]) {
      const key = JSON.stringify([
        declaration.source,
        declaration.moduleLocalName,
        childAlias ?? null,
      ]);
      const exactVersions = exactVersionsBySource.get(declaration.source);
      const version =
        exactVersions?.size === 1 ? exactVersions.values().next().value : undefined;
      const requirement = {
        source: declaration.source,
        moduleLocalName: declaration.moduleLocalName,
        ...(childAlias === undefined ? {} : { childAlias }),
        ...(version === undefined ? {} : { version }),
      };
      const existing = requirements.get(key);
      if (!existing || existing.version === undefined) {
        requirements.set(key, requirement);
      }
    }
  }
  return [...requirements.values()].sort(compareRequirements);
}

interface HclMask {
  readonly text: string;
  readonly complete: boolean;
}

function maskHclCommentsAndHeredocs(source: string): HclMask {
  const output = source.split("");
  let complete = true;
  const mask = (start: number, end: number): void => {
    for (let index = start; index < end && index < output.length; index += 1) {
      if (output[index] !== "\n") output[index] = " ";
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') {
      const end = quotedStringEnd(source, index);
      if (end === undefined) {
        complete = false;
        break;
      }
      index = end - 1;
      continue;
    }
    if (source[index] === "#" || (source[index] === "/" && source[index + 1] === "/")) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      mask(index, end);
      index = end - 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) {
        mask(index, source.length);
        complete = false;
        break;
      }
      mask(index, close + 2);
      index = close + 1;
      continue;
    }
    const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/u.exec(
      source.slice(index),
    );
    if (!heredoc) continue;
    const tag = heredoc[1]!;
    const bodyStart = index + heredoc[0].length;
    const terminator = new RegExp(`(?:^|\\n)[ \\t]*${tag}[ \\t]*(?:\\r?\\n|$)`, "u").exec(
      source.slice(bodyStart),
    );
    if (!terminator) {
      mask(bodyStart, source.length);
      complete = false;
      break;
    }
    const end = bodyStart + terminator.index + terminator[0].length;
    mask(index, end);
    index = end - 1;
  }
  return { text: output.join(""), complete };
}

interface HclBlock {
  readonly labels: readonly string[];
  readonly body: string;
}

function topLevelBlocks(
  source: string,
  blockType: string,
  labelCount: number,
): Readonly<{ blocks: readonly HclBlock[]; complete: boolean }> {
  const blocks: HclBlock[] = [];
  let complete = true;
  for (let index = 0; index < source.length;) {
    index = skipWhitespace(source, index);
    if (index >= source.length) break;
    if (source[index] === '"') {
      const end = quotedStringEnd(source, index);
      if (end === undefined) return { blocks, complete: false };
      index = end;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(source.slice(index));
    if (!identifier) {
      if (source[index] === "{") {
        const end = matchingDelimiter(source, index, "{", "}");
        if (end === undefined) return { blocks, complete: false };
        index = end;
      } else {
        index += 1;
      }
      continue;
    }
    const name = identifier[0];
    let cursor = index + name.length;
    const labels: string[] = [];
    for (let label = 0; label < labelCount; label += 1) {
      cursor = skipWhitespace(source, cursor);
      const token = readQuotedString(source, cursor);
      if (!token) break;
      labels.push(token.value);
      cursor = token.end;
    }
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== "{") {
      index += name.length;
      continue;
    }
    const end = matchingDelimiter(source, cursor, "{", "}");
    if (end === undefined) {
      complete = false;
      break;
    }
    if (name === blockType && labels.length === labelCount) {
      blocks.push({ labels, body: source.slice(cursor + 1, end - 1) });
    }
    index = end;
  }
  return { blocks, complete };
}

interface Assignment {
  readonly name: string;
  readonly expression: string;
}

function topLevelAssignments(
  source: string,
): Readonly<{ assignments: readonly Assignment[]; complete: boolean }> {
  const assignments: Assignment[] = [];
  for (let index = 0; index < source.length;) {
    index = skipWhitespaceAndCommas(source, index);
    if (index >= source.length) break;
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(source.slice(index));
    if (!identifier) {
      return { assignments, complete: false };
    }
    const name = identifier[0];
    let cursor = skipWhitespace(source, index + name.length);
    if (source[cursor] !== "=") {
      return { assignments, complete: false };
    }
    cursor = skipWhitespace(source, cursor + 1);
    if (cursor >= source.length) return { assignments, complete: false };
    const end = expressionEnd(source, cursor);
    if (end === undefined) {
      return { assignments, complete: false };
    }
    const expression = source.slice(cursor, end).trim();
    if (expression.length === 0) return { assignments, complete: false };
    assignments.push({ name, expression });
    index = end;
  }
  return { assignments, complete: true };
}

function expressionEnd(source: string, start: number): number | undefined {
  const first = source[start];
  if (first === "{") return matchingDelimiter(source, start, "{", "}");
  if (first === "[") return matchingDelimiter(source, start, "[", "]");
  if (first === "(") return matchingDelimiter(source, start, "(", ")");
  if (first === '"') return quotedStringEnd(source, start);
  let index = start;
  while (index < source.length) {
    if (source[index] === "\n" || source[index] === ",") return index + 1;
    const next = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=/u.exec(
      source.slice(index),
    );
    if (next) return index + next[0].indexOf(next[1]!);
    index += 1;
  }
  return source.length;
}

function matchingDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '"') {
      const end = quotedStringEnd(source, index);
      if (end === undefined) return undefined;
      index = end - 1;
      continue;
    }
    if (source[index] === open) depth += 1;
    if (source[index] !== close) continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return undefined;
}

function quotedStringEnd(source: string, start: number): number | undefined {
  if (source[start] !== '"') return undefined;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return undefined;
}

function readQuotedString(
  source: string,
  start: number,
): Readonly<{ value: string; end: number }> | undefined {
  const end = quotedStringEnd(source, start);
  if (end === undefined) return undefined;
  const raw = source.slice(start, end);
  try {
    return { value: JSON.parse(raw) as string, end };
  } catch {
    return undefined;
  }
}

function literalString(expression: string): string | undefined {
  const raw = expression.trim().replace(/[\r\n,]+$/u, "").trim();
  const token = readQuotedString(raw, 0);
  if (!token || token.end !== raw.length || hasTemplate(token.value)) {
    return undefined;
  }
  return token.value;
}

function parseAliases(
  expression: string,
  localName: string,
): readonly string[] | undefined {
  const source = expression.trim().replace(/,+$/u, "").trim();
  if (!source.startsWith("[") || !source.endsWith("]")) return undefined;
  return parseAliasEntries(source.slice(1, -1), localName);
}

function parseJsonAliases(
  value: unknown,
  localName: string,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return normalizeAliasEntries(value as string[], localName);
}

function parseAliasEntries(
  source: string,
  localName: string,
): readonly string[] | undefined {
  const entries = source
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const literal = literalString(entry);
      return literal ?? entry;
    });
  return normalizeAliasEntries(entries, localName);
}

function normalizeAliasEntries(
  entries: readonly string[],
  localName: string,
): readonly string[] | undefined {
  const aliases = new Set<string>();
  for (const entry of entries) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)$/u.exec(
      entry,
    );
    if (!match || match[1] !== localName) return undefined;
    aliases.add(match[2]!);
  }
  return [...aliases].sort(compareCodePoints);
}

function blockObjects(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(blockObjects);
  return isRecord(value) ? [value] : [];
}

function canonicalProviderAddress(source: string): string | undefined {
  const canonical = canonicalProviderSource(source);
  return PROVIDER_SOURCE.test(canonical) ? canonical : undefined;
}

function resolveLocalModuleDirectory(
  fromDirectory: string,
  source: string,
): string | undefined {
  const parts = [
    ...(fromDirectory === "." ? [] : fromDirectory.split("/")),
    ...source.replace(/\\/gu, "/").split("/"),
  ];
  const output: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (output.length === 0) return undefined;
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.length === 0 ? "." : output.join("/");
}

function normalizeDirectory(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.split("/").every((part) => part === "" || part === ".")
  ) {
    return ".";
  }
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("selected OpenTofu module directory must stay relative");
  }
  return normalized
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function normalizeFilePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("OpenTofu source file path must stay relative");
  }
  return normalized
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function isLocalModuleSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function hasTemplate(value: string): boolean {
  return value.includes("${") || value.includes("%{");
}

/**
 * A compatibility requirement may carry only one proven concrete version.
 * OpenTofu accepts range/operator expressions in required_providers, but those
 * are constraints rather than the immutable version selected by init.
 */
function exactProviderVersion(constraint: string): string | undefined {
  const candidate = constraint.trim().replace(/^=\s*/u, "");
  return EXACT_PROVIDER_VERSION.test(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index]!)) index += 1;
  return index;
}

function skipWhitespaceAndCommas(source: string, start: number): number {
  let index = start;
  while (
    index < source.length &&
    (/\s/u.test(source[index]!) || source[index] === ",")
  ) {
    index += 1;
  }
  return index;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRequirements(
  left: OpenTofuProviderRequirement,
  right: OpenTofuProviderRequirement,
): number {
  return (
    compareCodePoints(left.source, right.source) ||
    compareCodePoints(left.moduleLocalName, right.moduleLocalName) ||
    compareCodePoints(left.childAlias ?? "", right.childAlias ?? "")
  );
}

function assertLimits(limits: OpenTofuConfigurationLimits): void {
  for (const value of [
    limits.maxFiles,
    limits.maxFileBytes,
    limits.maxTotalBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("OpenTofu configuration limits must be positive integers");
    }
  }
}

const PROVIDER_LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const PROVIDER_SOURCE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9_-]+\/[a-z0-9_-]+$/u;
const EXACT_PROVIDER_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
