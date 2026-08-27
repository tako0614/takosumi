import { canonicalProviderSource } from "../../../contract/provider-env-rules.ts";

export interface OpenTofuSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface OpenTofuProviderPackage {
  readonly source: string;
  readonly version?: string;
}

export interface OpenTofuRootProviderRequirement {
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
  | "provider_version_constraints_conflict"
  | "provider_usage_incomplete"
  | "local_module_source_incomplete"
  | "remote_module_source_unresolved"
  | "local_module_source_escapes"
  | "local_module_source_missing"
  | "module_directory_unreadable"
  | "source_path_invalid"
  | "duplicate_source_file"
  | "module_candidate_limit_exceeded"
  | "module_execution_layout_unsupported"
  | "module_topology_incomplete"
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
  /** Reachable package set used only for install policy, mirrors, and locks. */
  readonly providerPackages: readonly OpenTofuProviderPackage[];
  /** Exact provider identities declared or used by the selected root directory. */
  readonly rootProviderRequirements: readonly OpenTofuRootProviderRequirement[];
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

export interface OpenTofuModuleCandidate {
  readonly path: string;
  readonly providerPackages: readonly OpenTofuProviderPackage[];
  readonly rootProviderRequirements: readonly OpenTofuRootProviderRequirement[];
}

export interface OpenTofuModuleDiscovery {
  readonly complete: boolean;
  readonly modules: readonly OpenTofuModuleCandidate[];
  readonly diagnostics: readonly OpenTofuConfigurationDiagnostic[];
}

export interface OpenTofuModuleDiscoveryInput {
  readonly files: readonly OpenTofuSourceFile[];
  readonly limits?: OpenTofuConfigurationLimits;
  readonly maxModules?: number;
}

export const DEFAULT_OPENTOFU_MODULE_CANDIDATE_LIMIT = 32;

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

/**
 * Discover independently installable root modules from one bounded Git tree.
 *
 * A directory containing OpenTofu configuration is a candidate unless another
 * configuration directory reaches it through a statically parsed local module
 * edge. Provider requirements are then compiled from each candidate and all of
 * its reachable local children. Dynamic/ambiguous module sources and any
 * global scan cap fail the whole observation closed: a partial candidate list
 * must never become install-path authority.
 */
export function discoverOpenTofuModules(
  input: OpenTofuModuleDiscoveryInput,
): OpenTofuModuleDiscovery {
  const limits = input.limits ?? DEFAULT_OPENTOFU_CONFIGURATION_LIMITS;
  assertLimits(limits);
  const maxModules =
    input.maxModules ?? DEFAULT_OPENTOFU_MODULE_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(maxModules) || maxModules <= 0) {
    throw new Error("OpenTofu module candidate limit must be a positive integer");
  }

  const normalized: OpenTofuSourceFile[] = [];
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of input.files) {
    if (openTofuConfigurationFileKind(file.path.replace(/\\/gu, "/")) === undefined) {
      continue;
    }
    let path: string;
    try {
      path = normalizeFilePath(file.path);
    } catch {
      diagnostics.push({
        code: "source_path_invalid",
        path: file.path,
        message: "OpenTofu source file path must stay relative to the source records.",
        fatal: true,
      });
      continue;
    }
    if (seenPaths.has(path)) {
      diagnostics.push({
        code: "duplicate_source_file",
        path,
        message: `OpenTofu source file ${path} was observed more than once.`,
        fatal: true,
      });
      continue;
    }
    seenPaths.add(path);
    const bytes = new TextEncoder().encode(file.text).byteLength;
    if (normalized.length >= limits.maxFiles) {
      diagnostics.push({
        code: "file_limit_exceeded",
        path,
        message: `OpenTofu module discovery exceeds ${limits.maxFiles} files.`,
        fatal: true,
      });
      break;
    }
    if (bytes > limits.maxFileBytes) {
      diagnostics.push({
        code: "file_too_large",
        path,
        message: `OpenTofu configuration file ${path} exceeds ${limits.maxFileBytes} bytes.`,
        fatal: true,
      });
      break;
    }
    if (totalBytes + bytes > limits.maxTotalBytes) {
      diagnostics.push({
        code: "total_bytes_exceeded",
        path,
        message: `OpenTofu module discovery exceeds ${limits.maxTotalBytes} bytes.`,
        fatal: true,
      });
      break;
    }
    normalized.push({ path, text: file.text });
    totalBytes += bytes;
  }
  if (diagnostics.some((diagnostic) => diagnostic.fatal)) {
    return incompleteModuleDiscovery(diagnostics);
  }
  normalized.sort((left, right) => compareCodePoints(left.path, right.path));
  const directories = [...new Set(normalized.map((file) => dirname(file.path)))]
    .sort(compareCodePoints);
  if (directories.length === 0) {
    return { complete: true, modules: [], diagnostics: [] };
  }

  const directorySet = new Set(directories);
  const childDirectories = new Set<string>();
  const graphs = new Map<string, OpenTofuConfigurationGraph>();
  for (const directory of directories) {
    const graph = compileOpenTofuConfigurationGraph({
      selectedModuleDirectory: directory,
      files: normalized,
      directories,
      limits,
    });
    graphs.set(directory, graph);
    diagnostics.push(...graph.diagnostics);
    for (const file of graph.files) {
      const reachableDirectory = dirname(file.path);
      if (
        reachableDirectory !== directory &&
        directorySet.has(reachableDirectory)
      ) {
        childDirectories.add(reachableDirectory);
      }
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.fatal)) {
    return incompleteModuleDiscovery(diagnostics);
  }

  const roots = directories.filter((directory) => !childDirectories.has(directory));
  if (roots.length === 0) {
    return incompleteModuleDiscovery([
      ...diagnostics,
      {
        code: "module_topology_incomplete",
        path: ".",
        message: "OpenTofu module discovery found no unambiguous root module.",
        fatal: true,
      },
    ]);
  }
  if (roots.length > maxModules) {
    return incompleteModuleDiscovery([
      ...diagnostics,
      {
        code: "module_candidate_limit_exceeded",
        path: ".",
        message: `OpenTofu module discovery exceeds ${maxModules} root modules.`,
        fatal: true,
      },
    ]);
  }
  for (const root of roots) {
    if (root === ".") continue;
    const prefix = `${root}/`;
    const outside = graphs
      .get(root)!
      .files.find((file) => {
        const directory = dirname(file.path);
        return directory !== root && !directory.startsWith(prefix);
      });
    if (outside) {
      return incompleteModuleDiscovery([
        ...diagnostics,
        {
          code: "module_execution_layout_unsupported",
          path: outside.path,
          message:
            "A discovered module reaches a local child outside its directory and cannot be materialized by the current generated-root runner.",
          fatal: true,
        },
      ]);
    }
  }
  return {
    complete: true,
    modules: roots.map((path) => ({
      path,
      providerPackages: graphs.get(path)!.providerPackages,
      rootProviderRequirements: graphs.get(path)!.rootProviderRequirements,
    })),
    diagnostics: [],
  };
}

function incompleteModuleDiscovery(
  diagnostics: readonly OpenTofuConfigurationDiagnostic[],
): OpenTofuModuleDiscovery {
  const unique = new Map<string, OpenTofuConfigurationDiagnostic>();
  for (const diagnostic of diagnostics) {
    unique.set(
      `${diagnostic.path}\0${diagnostic.code}\0${diagnostic.message}`,
      diagnostic,
    );
  }
  return {
    complete: false,
    modules: [],
    diagnostics: [...unique.values()].sort(
      (left, right) =>
        compareCodePoints(left.path, right.path) ||
        compareCodePoints(left.code, right.code) ||
        compareCodePoints(left.message, right.message),
    ),
  };
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
  readonly path: string;
  readonly source: string;
  readonly moduleLocalName: string;
  readonly childAliases: readonly string[];
  readonly version?: string;
}

interface CompiledDirectory {
  readonly declarations: readonly ProviderDeclaration[];
  readonly providerLocalNames: readonly string[];
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
  readonly #compiledDirectories = new Map<string, CompiledDirectory>();
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
    this.#compiledDirectories.set(current, compiled);
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
    const reachableDeclarations = [...this.#compiledDirectories.values()]
      .flatMap((directory) => directory.declarations);
    const selectedDeclarations =
      this.#compiledDirectories.get(this.#selected)?.declarations ?? [];
    const diagnostics = [
      ...this.#diagnostics,
      ...conflictingExactProviderVersionDiagnostics(reachableDeclarations),
    ];
    return {
      complete: !diagnostics.some((diagnostic) => diagnostic.fatal),
      files: [...this.#files].sort((left, right) =>
        compareCodePoints(left.path, right.path),
      ),
      providerPackages: mergeProviderPackages(reachableDeclarations),
      rootProviderRequirements:
        mergeRootProviderRequirements(selectedDeclarations),
      diagnostics: diagnostics.sort(
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
  const providerLocalNames = new Set<string>();
  const localModuleSources: Array<{ source: string; path: string }> = [];
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  for (const file of files) {
    const kind = openTofuConfigurationFileKind(file.path);
    if (kind === "json") {
      const compiled = compileJsonFile(file);
      declarations.push(...compiled.declarations);
      for (const localName of compiled.providerLocalNames) {
        providerLocalNames.add(localName);
      }
      localModuleSources.push(...compiled.localModuleSources);
      diagnostics.push(...compiled.diagnostics);
      continue;
    }
    if (kind === "hcl") {
      const compiled = compileHclFile(file);
      declarations.push(...compiled.declarations);
      for (const localName of compiled.providerLocalNames) {
        providerLocalNames.add(localName);
      }
      localModuleSources.push(...compiled.localModuleSources);
      diagnostics.push(...compiled.diagnostics);
    }
  }
  const declaredLocalNames = new Set(
    declarations.map((declaration) => declaration.moduleLocalName),
  );
  for (const localName of [...providerLocalNames].sort(compareCodePoints)) {
    if (declaredLocalNames.has(localName)) continue;
    const source = implicitProviderSource(localName);
    if (!source) {
      diagnostics.push({
        code: "provider_usage_incomplete",
        path: files[0]?.path ?? ".",
        message: `Implicit provider ${localName} could not be mapped to an exact source.`,
        fatal: true,
      });
      continue;
    }
    declarations.push({
      path: files[0]?.path ?? ".",
      source,
      moduleLocalName: localName,
      childAliases: [],
    });
  }
  return {
    declarations,
    providerLocalNames: [...providerLocalNames].sort(compareCodePoints),
    localModuleSources,
    diagnostics,
  };
}

function compileHclFile(file: OpenTofuSourceFile): CompiledDirectory {
  const declarations: ProviderDeclaration[] = [];
  const providerLocalNames = new Set<string>();
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
    return {
      declarations,
      providerLocalNames: [],
      localModuleSources,
      diagnostics,
    };
  }
  const terraform = topLevelBlocks(masked.text, "terraform", 0);
  const modules = topLevelBlocks(masked.text, "module", 1);
  const providerBlocks = topLevelBlocks(masked.text, "provider", 1);
  const providerConsumers = ["resource", "data", "ephemeral"].map(
    (blockType) => ({
      blockType,
      result: topLevelBlocks(masked.text, blockType, 2),
    }),
  );
  if (
    !terraform.complete ||
    !modules.complete ||
    !providerBlocks.complete ||
    providerConsumers.some(({ result }) => !result.complete)
  ) {
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
        const declaration = providerDeclarationFromHclAssignment(
          assignment,
          file.path,
        );
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
  for (const block of providerBlocks.blocks) {
    const localName = block.labels[0];
    if (!localName || !PROVIDER_LOCAL_NAME.test(localName)) {
      diagnostics.push({
        code: "provider_usage_incomplete",
        path: file.path,
        message: "A provider configuration local name could not be parsed exactly.",
        fatal: true,
      });
      continue;
    }
    providerLocalNames.add(localName);
  }
  for (const { blockType, result } of providerConsumers) {
    for (const block of result.blocks) {
      const resourceType = block.labels[0];
      const implicitLocalName = resourceType
        ? providerLocalNameFromResourceType(resourceType)
        : undefined;
      const explicit = topLevelProviderReference(block.body);
      if (explicit.status === "invalid") {
        diagnostics.push({
          code: "provider_usage_incomplete",
          path: file.path,
          message: `${blockType} ${resourceType ?? "<unknown>"} has a provider reference that could not be parsed exactly.`,
          fatal: true,
        });
        continue;
      }
      const localName =
        explicit.status === "present" ? explicit.localName : implicitLocalName;
      if (!localName) {
        diagnostics.push({
          code: "provider_usage_incomplete",
          path: file.path,
          message: `${blockType} ${resourceType ?? "<unknown>"} does not identify an exact provider local name.`,
          fatal: true,
        });
        continue;
      }
      providerLocalNames.add(localName);
    }
  }
  for (const localName of providerFunctionLocalNames(masked.text)) {
    providerLocalNames.add(localName);
  }
  for (const moduleBlock of modules.blocks) {
    const source = topLevelAssignmentExpression(moduleBlock.body, "source");
    if (source.status === "invalid") {
      diagnostics.push({
        code: "local_module_source_incomplete",
        path: file.path,
        message: `Module ${moduleBlock.labels[0] ?? "<unknown>"} could not be parsed exactly.`,
        fatal: true,
      });
      continue;
    }
    if (source.status === "absent") {
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
    } else {
      diagnostics.push({
        code: "remote_module_source_unresolved",
        path: file.path,
        message: `Module ${moduleBlock.labels[0] ?? "<unknown>"} uses a non-local source whose provider requirements were not observed.`,
        fatal: true,
      });
    }
  }
  return {
    declarations,
    providerLocalNames: [...providerLocalNames].sort(compareCodePoints),
    localModuleSources,
    diagnostics,
  };
}

function providerDeclarationFromHclAssignment(
  assignment: Assignment,
  path: string,
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
    path,
    source: canonical,
    moduleLocalName: localName,
    childAliases,
    ...(version === undefined ? {} : { version }),
  };
}

function compileJsonFile(file: OpenTofuSourceFile): CompiledDirectory {
  const declarations: ProviderDeclaration[] = [];
  const providerLocalNames = new Set<string>();
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
    return {
      declarations,
      providerLocalNames: [],
      localModuleSources,
      diagnostics,
    };
  }
  if (!isRecord(value)) {
    diagnostics.push({
      code: "json_invalid",
      path: file.path,
      message: "OpenTofu JSON configuration root must be an object.",
      fatal: true,
    });
    return {
      declarations,
      providerLocalNames: [],
      localModuleSources,
      diagnostics,
    };
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
          file.path,
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
  for (const providers of blockObjects(value.provider)) {
    for (const localName of Object.keys(providers)) {
      if (!PROVIDER_LOCAL_NAME.test(localName)) {
        diagnostics.push({
          code: "provider_usage_incomplete",
          path: file.path,
          message: "A JSON provider configuration local name could not be parsed exactly.",
          fatal: true,
        });
        continue;
      }
      providerLocalNames.add(localName);
    }
  }
  for (const blockType of ["resource", "data", "ephemeral"] as const) {
    for (const collections of blockObjects(value[blockType])) {
      for (const [resourceType, rawInstances] of Object.entries(collections)) {
        const implicitLocalName = providerLocalNameFromResourceType(resourceType);
        for (const instances of blockObjects(rawInstances)) {
          for (const body of Object.values(instances).flatMap(blockObjects)) {
            const explicit = jsonProviderReference(body.provider);
            if (explicit.status === "invalid") {
              diagnostics.push({
                code: "provider_usage_incomplete",
                path: file.path,
                message: `${blockType} ${resourceType} has a JSON provider reference that could not be parsed exactly.`,
                fatal: true,
              });
              continue;
            }
            const localName =
              explicit.status === "present"
                ? explicit.localName
                : implicitLocalName;
            if (!localName) {
              diagnostics.push({
                code: "provider_usage_incomplete",
                path: file.path,
                message: `${blockType} ${resourceType} does not identify an exact provider local name.`,
                fatal: true,
              });
              continue;
            }
            providerLocalNames.add(localName);
          }
        }
      }
    }
  }
  for (const localName of jsonProviderFunctionLocalNames(value)) {
    providerLocalNames.add(localName);
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
        } else {
          diagnostics.push({
            code: "remote_module_source_unresolved",
            path: file.path,
            message: `Module ${name} uses a non-local source whose provider requirements were not observed.`,
            fatal: true,
          });
        }
      }
    }
  }
  return {
    declarations,
    providerLocalNames: [...providerLocalNames].sort(compareCodePoints),
    localModuleSources,
    diagnostics,
  };
}

function providerDeclarationFromJson(
  localName: string,
  specification: unknown,
  path: string,
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
    path,
    source: canonical,
    moduleLocalName: localName,
    childAliases,
    ...(version === undefined ? {} : { version }),
  };
}

type ProviderReferenceObservation =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly localName: string }
  | { readonly status: "invalid" };

type AssignmentExpressionObservation =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly expression: string }
  | { readonly status: "invalid" };

function topLevelAssignmentExpression(
  source: string,
  target: string,
): AssignmentExpressionObservation {
  let expression: string | undefined;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') {
      const end = quotedStringEnd(source, index);
      if (end === undefined) return { status: "invalid" };
      index = end - 1;
      continue;
    }
    if (source[index] === "{") braces += 1;
    else if (source[index] === "}") braces -= 1;
    else if (source[index] === "[") brackets += 1;
    else if (source[index] === "]") brackets -= 1;
    else if (source[index] === "(") parentheses += 1;
    else if (source[index] === ")") parentheses -= 1;
    if (braces < 0 || brackets < 0 || parentheses < 0) {
      return { status: "invalid" };
    }
    if (braces !== 0 || brackets !== 0 || parentheses !== 0) continue;
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(
      source.slice(index),
    );
    if (!identifier) continue;
    const name = identifier[0];
    let cursor = skipWhitespace(source, index + name.length);
    if (name !== target || source[cursor] !== "=") {
      index += name.length - 1;
      continue;
    }
    if (expression !== undefined) return { status: "invalid" };
    cursor = skipWhitespace(source, cursor + 1);
    const end = expressionEnd(source, cursor);
    if (end === undefined) return { status: "invalid" };
    expression = source.slice(cursor, end).trim().replace(/,+$/u, "").trim();
    if (!expression) return { status: "invalid" };
    index = end - 1;
  }
  if (braces !== 0 || brackets !== 0 || parentheses !== 0) {
    return { status: "invalid" };
  }
  return expression === undefined
    ? { status: "absent" }
    : { status: "present", expression };
}

function topLevelProviderReference(
  source: string,
): ProviderReferenceObservation {
  let observed: ProviderReferenceObservation = { status: "absent" };
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"') {
      const end = quotedStringEnd(source, index);
      if (end === undefined) return { status: "invalid" };
      index = end - 1;
      continue;
    }
    if (source[index] === "{") braces += 1;
    else if (source[index] === "}") braces -= 1;
    else if (source[index] === "[") brackets += 1;
    else if (source[index] === "]") brackets -= 1;
    else if (source[index] === "(") parentheses += 1;
    else if (source[index] === ")") parentheses -= 1;
    if (braces < 0 || brackets < 0 || parentheses < 0) {
      return { status: "invalid" };
    }
    if (braces !== 0 || brackets !== 0 || parentheses !== 0) continue;
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(
      source.slice(index),
    );
    if (!identifier) continue;
    const name = identifier[0];
    let cursor = skipWhitespace(source, index + name.length);
    if (name !== "provider" || source[cursor] !== "=") {
      index += name.length - 1;
      continue;
    }
    cursor = skipWhitespace(source, cursor + 1);
    const end = expressionEnd(source, cursor);
    if (end === undefined) return { status: "invalid" };
    const expression = source
      .slice(cursor, end)
      .trim()
      .replace(/,+$/u, "")
      .trim();
    const reference = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*)?$/u.exec(
      expression,
    );
    if (!reference || observed.status !== "absent") {
      return { status: "invalid" };
    }
    observed = { status: "present", localName: reference[1]! };
    index = end - 1;
  }
  return braces === 0 && brackets === 0 && parentheses === 0
    ? observed
    : { status: "invalid" };
}

function jsonProviderReference(value: unknown): ProviderReferenceObservation {
  if (value === undefined) return { status: "absent" };
  if (typeof value !== "string") return { status: "invalid" };
  const trimmed = value.trim();
  const expression =
    trimmed.startsWith("${") && trimmed.endsWith("}")
      ? trimmed.slice(2, -1).trim()
      : trimmed;
  const reference = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*)?$/u.exec(
    expression,
  );
  return reference
    ? { status: "present", localName: reference[1]! }
    : { status: "invalid" };
}

function providerLocalNameFromResourceType(
  resourceType: string,
): string | undefined {
  const separator = resourceType.indexOf("_");
  const localName = separator > 0 ? resourceType.slice(0, separator) : resourceType;
  return PROVIDER_LOCAL_NAME.test(localName) ? localName : undefined;
}

function implicitProviderSource(localName: string): string | undefined {
  return canonicalProviderAddress(
    localName === "terraform"
      ? "terraform.io/builtin/terraform"
      : `hashicorp/${localName}`,
  );
}

function providerFunctionLocalNames(source: string): readonly string[] {
  const code = maskHclQuotedStrings(source);
  const names = new Set<string>();
  const pattern = /\bprovider::([A-Za-z_][A-Za-z0-9_-]*)::/gu;
  for (const match of code.matchAll(pattern)) names.add(match[1]!);
  return [...names].sort(compareCodePoints);
}

function maskHclQuotedStrings(source: string): string {
  const output = source.split("");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '"') continue;
    const end = quotedStringEnd(source, index);
    if (end === undefined) return "";
    for (let cursor = index; cursor < end; cursor += 1) {
      if (output[cursor] !== "\n") output[cursor] = " ";
    }
    index = end - 1;
  }
  return output.join("");
}

function jsonProviderFunctionLocalNames(value: unknown): readonly string[] {
  const names = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (!current.includes("${")) continue;
      for (const match of current.matchAll(
        /\bprovider::([A-Za-z_][A-Za-z0-9_-]*)::/gu,
      )) {
        names.add(match[1]!);
      }
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (isRecord(current)) pending.push(...Object.values(current));
  }
  return [...names].sort(compareCodePoints);
}

function conflictingExactProviderVersionDiagnostics(
  declarations: readonly ProviderDeclaration[],
): readonly OpenTofuConfigurationDiagnostic[] {
  const bySource = new Map<string, ProviderDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.version === undefined) continue;
    bySource.set(declaration.source, [
      ...(bySource.get(declaration.source) ?? []),
      declaration,
    ]);
  }
  const diagnostics: OpenTofuConfigurationDiagnostic[] = [];
  for (const [source, entries] of bySource) {
    const versions = [...new Set(entries.map((entry) => entry.version!))]
      .sort(compareCodePoints);
    if (versions.length < 2) continue;
    const paths = [...new Set(entries.map((entry) => entry.path))]
      .sort(compareCodePoints);
    diagnostics.push({
      code: "provider_version_constraints_conflict",
      path: paths[0] ?? ".",
      message: `Provider ${source} has conflicting exact versions ${versions.join(", ")} across reachable configuration (${paths.join(", ")}).`,
      fatal: true,
    });
  }
  return diagnostics.sort(
    (left, right) =>
      compareCodePoints(left.path, right.path) ||
      compareCodePoints(left.message, right.message),
  );
}

function mergeProviderPackages(
  declarations: readonly ProviderDeclaration[],
): readonly OpenTofuProviderPackage[] {
  const exactVersionsBySource = exactProviderVersionsBySource(declarations);
  const sources = new Set(
    declarations.map((declaration) => declaration.source),
  );
  return [...sources]
    .sort(compareCodePoints)
    .map((source) => {
      const exactVersions = exactVersionsBySource.get(source);
      const version =
        exactVersions?.size === 1 ? exactVersions.values().next().value : undefined;
      return {
        source,
        ...(version === undefined ? {} : { version }),
      };
    });
}

function mergeRootProviderRequirements(
  declarations: readonly ProviderDeclaration[],
): readonly OpenTofuRootProviderRequirement[] {
  const requirements = new Map<string, OpenTofuRootProviderRequirement>();
  for (const declaration of declarations) {
    for (const childAlias of [undefined, ...declaration.childAliases]) {
      const key = JSON.stringify([
        declaration.source,
        declaration.moduleLocalName,
        childAlias ?? null,
      ]);
      const requirement = {
        source: declaration.source,
        moduleLocalName: declaration.moduleLocalName,
        ...(childAlias === undefined ? {} : { childAlias }),
        ...(declaration.version === undefined
          ? {}
          : { version: declaration.version }),
      };
      const existing = requirements.get(key);
      if (!existing || existing.version === undefined) {
        requirements.set(key, requirement);
      }
    }
  }
  return [...requirements.values()].sort(compareRootProviderRequirements);
}

function exactProviderVersionsBySource(
  declarations: readonly ProviderDeclaration[],
): ReadonlyMap<string, Set<string>> {
  const exactVersionsBySource = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    if (declaration.version === undefined) continue;
    const versions = exactVersionsBySource.get(declaration.source) ?? new Set();
    versions.add(declaration.version);
    exactVersionsBySource.set(declaration.source, versions);
  }
  return exactVersionsBySource;
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

function compareRootProviderRequirements(
  left: OpenTofuRootProviderRequirement,
  right: OpenTofuRootProviderRequirement,
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
