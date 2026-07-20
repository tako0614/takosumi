import type {
  FormInterfaceDescriptor,
  FormOperation,
  FormRef,
  JsonObject,
  JsonValue,
} from "takosumi-contract";
import type {
  FormPackageVerifier,
  VerifiedFormDefinition,
  VerifiedFormPackage,
} from "../../domains/service-forms/mod.ts";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import {
  canonicalJsonBytes,
  type CanonicalJsonValue,
  parseCanonicalJson,
} from "./canonical_json.ts";
import type { TakoformPackageSignatureVerifier } from "./signature.ts";
import {
  type StaticSchemaValidator,
  validateTakoformFormDefinition,
  validateTakoformPackageIndex,
} from "./json_schema_2020.ts";
import {
  assertDraft202012Schema,
  InterpretedDraft202012Validator,
} from "../../shared/json-schema/draft_2020.ts";

export const TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE =
  "application/vnd.takosumi.takoform-package-install.v1+json";

const FORM_DEFINITION_MEDIA_TYPE =
  "application/vnd.takoform.form-definition.v1+json";
const MAX_ENVELOPE_BYTES = 32 << 20;
const MAX_INDEX_BYTES = 4 << 20;
const MAX_DEFINITION_BYTES = 4 << 20;
const MAX_JSON_BYTES = 16 << 20;
const MAX_FILE_BYTES = 16 << 20;
const MAX_PACKAGE_BYTES = 16 << 20;
const MAX_PACKAGE_FILES = 1024;
const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_VALIDATION_WORK = 16_384;
const PACKAGE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const EXECUTABLE_EXTENSIONS = new Set([
  ".bat",
  ".bin",
  ".c",
  ".cc",
  ".class",
  ".cmd",
  ".com",
  ".cpp",
  ".cs",
  ".cxx",
  ".dll",
  ".dylib",
  ".exe",
  ".go",
  ".groovy",
  ".h",
  ".hcl",
  ".hpp",
  ".htm",
  ".html",
  ".jar",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".php",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".so",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".ts",
  ".tsx",
  ".vue",
  ".wasm",
]);
const JSON_MEDIA_TYPES = new Set([
  FORM_DEFINITION_MEDIA_TYPE,
  "application/schema+json",
  "application/json",
]);
const TEXT_MEDIA_TYPES = new Set([
  ...JSON_MEDIA_TYPES,
  "text/markdown",
  "text/plain",
]);

interface PackageIndex {
  readonly apiVersion: string;
  readonly kind: string;
  readonly packageVersion: string;
  readonly formRef: FormRef;
  readonly definitionPath: string;
  readonly files: readonly PackageFile[];
}

interface PackageFile {
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: string;
}

interface InstallEnvelopeFile {
  readonly path: string;
  readonly mode: number;
  readonly contentBase64: string;
}

interface InstallEnvelope {
  readonly mediaType: typeof TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE;
  readonly packageIndexBase64: string;
  readonly files: readonly InstallEnvelopeFile[];
  readonly sigstoreBundle: unknown;
}

interface TakoformDefinition {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly desiredSchema: CanonicalJsonValue;
  readonly observedSchema: CanonicalJsonValue;
  readonly outputSchema?: CanonicalJsonValue;
  readonly immutableFields?: readonly string[];
  readonly lifecycleCapabilities: readonly string[];
  readonly interfaces?: readonly {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly document?: CanonicalJsonValue;
    readonly documentSchema?: CanonicalJsonValue;
    readonly inputs?: readonly {
      readonly name: string;
      readonly source: string;
      readonly pointer?: string;
      readonly value?: CanonicalJsonValue;
    }[];
  }[];
  readonly conformanceFixtures?: readonly {
    readonly name: string;
    readonly desiredPath: string;
    readonly observedPath?: string;
    readonly outputPath?: string;
  }[];
  readonly negativeConformanceFixtures?: readonly {
    readonly name: string;
    readonly stage: "desired" | "observed" | "output";
    readonly inputPath: string;
    readonly expectedFailure: string;
  }[];
}

/**
 * Takosumi host adapter for the independent Takoform Form Package v1alpha1
 * contract. The internal envelope is transport only; package and FormRef
 * identity remain the signed canonical Takoform index and definition.
 */
export class TakoformDataOnlyPackageVerifier implements FormPackageVerifier {
  readonly id: string;

  constructor(
    private readonly signatureVerifier: TakoformPackageSignatureVerifier,
  ) {
    this.id = `takoform.form-package.v1alpha1+${signatureVerifier.id}`;
  }

  async verify(
    bytes: Uint8Array,
    expectedPackageDigest: string,
  ): Promise<VerifiedFormPackage> {
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
      throw new TypeError(
        `Form Package envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      );
    }
    const envelope = decodeEnvelope(parseCanonicalJson(bytes));
    const indexBytes = decodeBase64(
      envelope.packageIndexBase64,
      "packageIndexBase64",
      MAX_INDEX_BYTES,
    );
    const indexValue = parseCanonicalJson(indexBytes);
    assertSchema(
      validateTakoformPackageIndex,
      indexValue,
      "package-index.json",
    );
    const index = indexValue as unknown as PackageIndex;
    assertPackageIndexClosure(index);

    const canonicalIndex = canonicalJsonBytes(indexValue);
    const packageDigest = `sha256:${await sha256HexAsync(canonicalIndex)}`;
    if (packageDigest !== expectedPackageDigest) {
      throw new TypeError(
        `package digest mismatch: expected ${expectedPackageDigest}, got ${packageDigest}`,
      );
    }
    await this.signatureVerifier.verify(
      canonicalIndex,
      envelope.sigstoreBundle,
    );

    const payloads = await verifyPayloadClosure(index, envelope.files);
    const definitionPayload = payloads.get(index.definitionPath);
    if (!definitionPayload) {
      throw new TypeError(
        "definitionPath is missing from verified payload closure",
      );
    }
    const definitionValue = parseCanonicalJson(definitionPayload);
    assertSchema(
      validateTakoformFormDefinition,
      definitionValue,
      "Form Definition",
    );
    rejectForbiddenDefinitionContent(definitionValue, "$");
    const definition = definitionValue as unknown as TakoformDefinition;
    verifyDefinitionSemantics(definition);
    verifyPortableSchema(definition.desiredSchema, "desiredSchema");
    verifyPortableSchema(definition.observedSchema, "observedSchema");
    if (definition.outputSchema !== undefined) {
      verifyPortableSchema(definition.outputSchema, "outputSchema");
    }
    for (const [position, descriptor] of (
      definition.interfaces ?? []
    ).entries()) {
      if (isRecord(descriptor) && descriptor.documentSchema !== undefined) {
        verifyPortableSchema(
          descriptor.documentSchema,
          `interfaces[${position}].documentSchema`,
        );
      }
    }
    await verifyDefinitionIdentity(index, definitionValue, definition);
    verifyConformanceFixtures(index, definition, payloads);

    const verifiedDefinition: VerifiedFormDefinition = {
      formRef: index.formRef,
      displayName: definition.title,
      ...(definition.description
        ? { description: definition.description }
        : {}),
      operations: lifecycleOperations(
        definition.lifecycleCapabilities,
        definition.status,
      ),
      metadata: definitionMetadata(definition),
      ...(definition.interfaces?.length
        ? { interfaceDescriptors: verifiedInterfaceDescriptors(definition) }
        : {}),
    };
    return { packageDigest, definitions: [verifiedDefinition] };
  }
}

function verifyDefinitionSemantics(definition: TakoformDefinition): void {
  const interfaces = new Set<string>();
  for (const [position, descriptor] of (
    definition.interfaces ?? []
  ).entries()) {
    const key = `${descriptor.name}@${descriptor.version}`;
    if (interfaces.has(key)) {
      throw new TypeError(`duplicate Interface ${key}`);
    }
    interfaces.add(key);
    const inputs = new Set<string>();
    for (const input of descriptor.inputs ?? []) {
      if (inputs.has(input.name)) {
        throw new TypeError(`duplicate Interface input ${key}:${input.name}`);
      }
      inputs.add(input.name);
      if (input.source === "literal") {
        if (input.value === undefined || input.pointer !== undefined) {
          throw new TypeError(
            `literal Interface input ${key}:${input.name} requires value and forbids pointer`,
          );
        }
      } else if (input.value !== undefined) {
        throw new TypeError(
          `non-literal Interface input ${key}:${input.name} forbids value`,
        );
      }
    }
    if (descriptor.documentSchema !== undefined) {
      let validateDocument: InterpretedDraft202012Validator;
      try {
        validateDocument = new InterpretedDraft202012Validator(
          descriptor.documentSchema,
        );
      } catch (error) {
        throw new TypeError(
          `interfaces[${position}].documentSchema could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const document = descriptor.document ?? {};
      if (!validateDocument.validate(document)) {
        throw new TypeError(
          `interfaces[${position}].document does not satisfy documentSchema: ${validateDocument.errorsText()}`,
        );
      }
    }
  }

  const fixtureNames = new Set<string>();
  for (const fixture of definition.conformanceFixtures ?? []) {
    if (fixtureNames.has(fixture.name)) {
      throw new TypeError(`duplicate conformance fixture name ${fixture.name}`);
    }
    fixtureNames.add(fixture.name);
  }
  for (const fixture of definition.negativeConformanceFixtures ?? []) {
    if (fixtureNames.has(fixture.name)) {
      throw new TypeError(`duplicate conformance fixture name ${fixture.name}`);
    }
    fixtureNames.add(fixture.name);
  }
}

function verifiedInterfaceDescriptors(
  definition: TakoformDefinition,
): readonly FormInterfaceDescriptor[] {
  return (definition.interfaces ?? []).map((descriptor) => ({
    name: descriptor.name,
    version: descriptor.version,
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(descriptor.required === true ? { required: true } : {}),
    ...(descriptor.document !== undefined
      ? { document: descriptor.document as JsonObject }
      : {}),
    ...(descriptor.documentSchema !== undefined
      ? { documentSchema: descriptor.documentSchema as JsonObject }
      : {}),
    ...(descriptor.inputs?.length
      ? {
          inputs: descriptor.inputs.map((input) => ({
            name: input.name,
            source: input.source,
            ...(input.pointer !== undefined ? { pointer: input.pointer } : {}),
            ...(input.value !== undefined
              ? { value: input.value as JsonValue }
              : {}),
          })),
        }
      : {}),
  }));
}

function decodeEnvelope(value: CanonicalJsonValue): InstallEnvelope {
  if (!isRecord(value))
    throw new TypeError("install envelope must be an object");
  assertExactKeys(
    value,
    ["mediaType", "packageIndexBase64", "files", "sigstoreBundle"],
    "install envelope",
  );
  if (value.mediaType !== TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE) {
    throw new TypeError("unsupported Takoform install-envelope media type");
  }
  if (typeof value.packageIndexBase64 !== "string") {
    throw new TypeError("packageIndexBase64 must be a base64 string");
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_PACKAGE_FILES) {
    throw new TypeError(
      `files must contain at most ${MAX_PACKAGE_FILES} entries`,
    );
  }
  const files = value.files.map((entry, position) => {
    if (!isRecord(entry))
      throw new TypeError(`files[${position}] must be an object`);
    assertExactKeys(
      entry,
      ["path", "mode", "contentBase64"],
      `files[${position}]`,
    );
    if (typeof entry.path !== "string" || !validPackagePath(entry.path)) {
      throw new TypeError(`files[${position}].path is not canonical`);
    }
    if (
      typeof entry.mode !== "number" ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw new TypeError(
        `files[${position}].mode must be an octal permission value`,
      );
    }
    if (typeof entry.contentBase64 !== "string") {
      throw new TypeError(`files[${position}].contentBase64 must be base64`);
    }
    return {
      path: entry.path,
      mode: entry.mode,
      contentBase64: entry.contentBase64,
    };
  });
  return {
    mediaType: TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
    packageIndexBase64: value.packageIndexBase64,
    files,
    sigstoreBundle: value.sigstoreBundle,
  };
}

function assertPackageIndexClosure(index: PackageIndex): void {
  if (index.files.length > MAX_PACKAGE_FILES) {
    throw new TypeError(
      `package lists more than ${MAX_PACKAGE_FILES} payloads`,
    );
  }
  let previous = "";
  let definitionCount = 0;
  for (const file of index.files) {
    if (!validPackagePath(file.path) || file.path === "package-index.json") {
      throw new TypeError(`package file path ${file.path} is not canonical`);
    }
    if (previous !== "" && previous >= file.path) {
      throw new TypeError(
        "package files must be unique and lexicographically sorted",
      );
    }
    previous = file.path;
    if (!TEXT_MEDIA_TYPES.has(file.mediaType)) {
      throw new TypeError(`unsupported data-only media type ${file.mediaType}`);
    }
    validateMediaType(file.path, file.mediaType);
    const maximum = payloadLimit(file.mediaType);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > maximum
    ) {
      throw new TypeError(
        `payload size for ${file.path} must be at most ${maximum} bytes`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(file.digest)) {
      throw new TypeError(`invalid payload digest for ${file.path}`);
    }
    if (file.mediaType === FORM_DEFINITION_MEDIA_TYPE) definitionCount++;
  }
  if (definitionCount !== 1) {
    throw new TypeError(
      "one Form Package must contain exactly one Form Definition",
    );
  }
  const definitionFile = index.files.find(
    (file) => file.path === index.definitionPath,
  );
  if (definitionFile?.mediaType !== FORM_DEFINITION_MEDIA_TYPE) {
    throw new TypeError(
      "definitionPath must name the one Form Definition payload",
    );
  }
}

async function verifyPayloadClosure(
  index: PackageIndex,
  envelopeFiles: readonly InstallEnvelopeFile[],
): Promise<Map<string, Uint8Array>> {
  if (envelopeFiles.length !== index.files.length) {
    throw new TypeError("install envelope has missing or unlisted payloads");
  }
  const envelopeByPath = new Map<string, InstallEnvelopeFile>();
  for (const file of envelopeFiles) {
    if (envelopeByPath.has(file.path)) {
      throw new TypeError(`duplicate install-envelope payload ${file.path}`);
    }
    if ((file.mode & 0o111) !== 0) {
      throw new TypeError(`payload ${file.path} is executable`);
    }
    if (EXECUTABLE_EXTENSIONS.has(extension(file.path))) {
      throw new TypeError(
        `payload ${file.path} has an executable-code extension`,
      );
    }
    envelopeByPath.set(file.path, file);
  }

  const result = new Map<string, Uint8Array>();
  let total = 0;
  for (const indexed of index.files) {
    const envelope = envelopeByPath.get(indexed.path);
    if (!envelope) throw new TypeError(`payload ${indexed.path} is missing`);
    const body = decodeBase64(
      envelope.contentBase64,
      `payload ${indexed.path}`,
      payloadLimit(indexed.mediaType),
    );
    total += body.byteLength;
    if (total > MAX_PACKAGE_BYTES) {
      throw new TypeError(`package payload exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    if (body.byteLength !== indexed.size) {
      throw new TypeError(`payload size mismatch for ${indexed.path}`);
    }
    const digest = `sha256:${await sha256HexAsync(body)}`;
    if (digest !== indexed.digest) {
      throw new TypeError(`payload digest mismatch for ${indexed.path}`);
    }
    assertTextPayload(body, indexed.path);
    if (JSON_MEDIA_TYPES.has(indexed.mediaType)) {
      rejectForbiddenDefinitionContent(parseCanonicalJson(body), indexed.path);
    }
    result.set(indexed.path, body);
  }
  return result;
}

async function verifyDefinitionIdentity(
  index: PackageIndex,
  value: CanonicalJsonValue,
  definition: TakoformDefinition,
): Promise<void> {
  const digest = `sha256:${await sha256HexAsync(canonicalJsonBytes(value))}`;
  const exact = index.formRef;
  if (
    exact.apiVersion !== definition.apiVersion ||
    exact.kind !== definition.kind ||
    exact.definitionVersion !== definition.definitionVersion ||
    exact.schemaDigest !== digest
  ) {
    throw new TypeError("FormRef does not match the canonical Form Definition");
  }
}

function verifyPortableSchema(value: CanonicalJsonValue, label: string): void {
  assertDraft202012Schema(value, label);
  const root = value;
  let operations = 0;
  const visiting = new Set<string>();
  const completed = new Map<string, "closed" | "excluded">();
  const visit = (
    node: CanonicalJsonValue,
    location: string,
    pointer: string,
    depth: number,
  ): "closed" | "excluded" => {
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new TypeError(
        `${label} exceeds portable schema depth ${MAX_SCHEMA_DEPTH}`,
      );
    }
    operations++;
    if (operations > MAX_SCHEMA_NODES) {
      throw new TypeError(
        `${label} exceeds portable schema node/ref budget ${MAX_SCHEMA_NODES}`,
      );
    }
    if (visiting.has(pointer))
      throw new TypeError(`${label} has cyclic local references`);
    const completedAdmission = completed.get(pointer);
    if (completedAdmission !== undefined) return completedAdmission;
    if (node === false) return "excluded";
    if (node === true || !isRecord(node)) {
      throw new TypeError(`${location} can admit arbitrary object values`);
    }
    visiting.add(pointer);
    for (const forbidden of [
      "patternProperties",
      "dependencies",
      "contentEncoding",
      "contentMediaType",
      "contentSchema",
      "$id",
      "$anchor",
      "$dynamicAnchor",
      "$dynamicRef",
      "$recursiveAnchor",
      "$recursiveRef",
      "$vocabulary",
    ]) {
      if (forbidden in node)
        throw new TypeError(`${location}.${forbidden} is not portable`);
    }
    if (typeof node.pattern === "string") {
      try {
        new RegExp(node.pattern, "u");
      } catch (error) {
        throw new TypeError(
          `${location}.pattern is not a valid ECMA-262 pattern`,
          { cause: error },
        );
      }
    }
    if (
      node.$schema !== undefined &&
      node.$schema !== "https://json-schema.org/draft/2020-12/schema"
    ) {
      throw new TypeError(`${location} must remain Draft 2020-12`);
    }
    assertSchemaFieldNameArray(node.required, `${location}.required`);
    assertDependentRequiredNames(
      node.dependentRequired,
      `${location}.dependentRequired`,
    );
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const objectType = types.includes("object");
    const arrayType = types.includes("array");
    if (arrayType && node.items === undefined) {
      throw new TypeError(`${location} array schema must declare items`);
    }
    let admission: "closed" | "excluded" | "open" =
      node.type === undefined ? "open" : objectType ? "closed" : "excluded";
    if (objectType && !objectSchemaIsClosed(node)) {
      throw new TypeError(`${location} object schema is not explicitly closed`);
    }
    if (!objectType && hasObjectKeywords(node) && node.type !== undefined) {
      throw new TypeError(
        `${location} uses object keywords without type=object`,
      );
    }
    const compoundModes = new Map<string, Array<"closed" | "excluded">>();
    for (const [keyword, children] of Object.entries(node)) {
      if (
        ["$defs", "definitions", "properties", "dependentSchemas"].includes(
          keyword,
        )
      ) {
        if (!isRecord(children))
          throw new TypeError(`${location}.${keyword} must be an object`);
        for (const [name, child] of Object.entries(children)) {
          visit(
            child,
            `${location}.${keyword}.${name}`,
            `${pointer}/${keyword}/${escapePointer(name)}`,
            depth + 1,
          );
        }
      } else if (
        [
          "additionalProperties",
          "items",
          "contains",
          "unevaluatedItems",
          "unevaluatedProperties",
          "propertyNames",
          "not",
          "if",
          "then",
          "else",
        ].includes(keyword) &&
        children !== false
      ) {
        visit(
          children,
          `${location}.${keyword}`,
          `${pointer}/${keyword}`,
          depth + 1,
        );
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(keyword)) {
        if (!Array.isArray(children) || children.length === 0) {
          throw new TypeError(
            `${location}.${keyword} must be a non-empty schema array`,
          );
        }
        const modes = children.map((child, position) =>
          visit(
            child,
            `${location}.${keyword}[${position}]`,
            `${pointer}/${keyword}/${position}`,
            depth + 1,
          ),
        );
        if (["allOf", "anyOf", "oneOf"].includes(keyword)) {
          compoundModes.set(keyword, modes);
        }
      }
    }
    if (node.const !== undefined) {
      admission = intersectAdmission(
        admission,
        admissionForLiteral(node.const),
      );
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        throw new TypeError(`${location}.enum must be a non-empty array`);
      }
      const enumAdmission = node.enum.reduce<"closed" | "excluded" | "open">(
        (current, candidate) =>
          unionAdmission(current, admissionForLiteral(candidate)),
        "excluded",
      );
      admission = intersectAdmission(admission, enumAdmission);
    }
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#"))
        throw new TypeError(`${location} has a non-local $ref`);
      const target = resolvePointer(root, node.$ref);
      admission = intersectAdmission(
        admission,
        visit(target, `${location}.$ref`, node.$ref || "#", depth + 1),
      );
    } else if (node.$ref !== undefined) {
      throw new TypeError(`${location}.$ref must be a string`);
    }
    const allOf = compoundModes.get("allOf");
    if (allOf) {
      admission = intersectAdmission(
        admission,
        allOf.reduce<"closed" | "excluded" | "open">(
          (current, candidate) => intersectAdmission(current, candidate),
          "open",
        ),
      );
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      const modes = compoundModes.get(keyword);
      if (!modes) continue;
      admission = intersectAdmission(
        admission,
        modes.reduce<"closed" | "excluded" | "open">(
          (current, candidate) => unionAdmission(current, candidate),
          "excluded",
        ),
      );
    }
    visiting.delete(pointer);
    if (admission === "open") {
      throw new TypeError(`${location} can admit arbitrary object values`);
    }
    completed.set(pointer, admission);
    return admission;
  };
  visit(root, label, "#", 0);
  const validationWork = estimateSchemaValidationWork(root);
  if (validationWork > MAX_SCHEMA_VALIDATION_WORK) {
    throw new TypeError(
      `${label} worst-case validation work exceeds ${MAX_SCHEMA_VALIDATION_WORK} schema evaluations`,
    );
  }
  try {
    new InterpretedDraft202012Validator(root);
  } catch (error) {
    throw new TypeError(`${label} cannot be prepared for validation`, {
      cause: error,
    });
  }
}

function estimateSchemaValidationWork(root: CanonicalJsonValue): number {
  const memo = new Map<string, number | "visiting">();
  const estimate = (node: CanonicalJsonValue, pointer: string): number => {
    const known = memo.get(pointer);
    if (known === "visiting") {
      throw new TypeError(`cyclic schema reference at ${pointer}`);
    }
    if (known !== undefined) return known;
    memo.set(pointer, "visiting");
    if (typeof node === "boolean") {
      memo.set(pointer, 1);
      return 1;
    }
    if (!isRecord(node)) {
      throw new TypeError(`schema node ${pointer} is not an object or boolean`);
    }
    let work = 1;
    const add = (child: CanonicalJsonValue, childPointer: string) => {
      work = boundedWorkAdd(work, estimate(child, childPointer));
    };
    for (const keyword of ["properties", "dependentSchemas"] as const) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!isRecord(children)) {
        throw new TypeError(`${pointer}/${keyword} must be an object`);
      }
      for (const [name, child] of Object.entries(children)) {
        add(child, `${pointer}/${keyword}/${escapePointer(name)}`);
      }
    }
    for (const keyword of [
      "additionalProperties",
      "items",
      "contains",
      "unevaluatedItems",
      "unevaluatedProperties",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
    ] as const) {
      const child = node[keyword];
      if (child !== undefined) add(child, `${pointer}/${keyword}`);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children)) {
        throw new TypeError(`${pointer}/${keyword} must be an array`);
      }
      children.forEach((child, position) =>
        add(child, `${pointer}/${keyword}/${position}`),
      );
    }
    if (typeof node.$ref === "string") {
      add(resolvePointer(root, node.$ref), node.$ref || "#");
    }
    memo.set(pointer, work);
    return work;
  };
  return estimate(root, "#");
}

function boundedWorkAdd(left: number, right: number): number {
  const overflow = MAX_SCHEMA_VALIDATION_WORK + 1;
  if (left >= overflow || right >= overflow || left > overflow - right) {
    return overflow;
  }
  return left + right;
}

function assertFixtureValidationBudget(
  schema: CanonicalJsonValue,
  instance: CanonicalJsonValue,
  label: string,
): void {
  const schemaWork = estimateSchemaValidationWork(schema);
  const instanceNodes = countJsonNodes(instance);
  if (
    schemaWork > MAX_SCHEMA_VALIDATION_WORK ||
    instanceNodes > Math.floor(MAX_SCHEMA_VALIDATION_WORK / schemaWork)
  ) {
    throw new TypeError(
      `fixture ${label} validation work exceeds ${MAX_SCHEMA_VALIDATION_WORK} schema evaluations`,
    );
  }
}

function countJsonNodes(value: CanonicalJsonValue): number {
  let count = 1;
  const add = (child: CanonicalJsonValue) => {
    count = boundedWorkAdd(count, countJsonNodes(child));
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (isRecord(value)) Object.values(value).forEach(add);
  return count;
}

function objectSchemaIsClosed(
  schema: Readonly<Record<string, CanonicalJsonValue>>,
): boolean {
  if (schema.additionalProperties === false) return true;
  if (
    isRecord(schema.additionalProperties) &&
    isRecord(schema.propertyNames) &&
    schema.propertyNames.type === "string" &&
    schema.propertyNames.pattern === "^[A-Za-z][A-Za-z0-9._-]{0,63}$" &&
    schema.propertyNames["x-takoform-fieldPolicy"] ===
      "portable-data-only-v1" &&
    schema.properties === undefined &&
    schema.required === undefined &&
    schema.dependentRequired === undefined &&
    schema.dependentSchemas === undefined &&
    schema.unevaluatedProperties === undefined
  ) {
    return true;
  }
  return false;
}

function hasObjectKeywords(
  schema: Readonly<Record<string, CanonicalJsonValue>>,
): boolean {
  return [
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "dependentRequired",
    "dependentSchemas",
    "unevaluatedProperties",
    "minProperties",
    "maxProperties",
  ].some((key) => key in schema);
}

function admissionForLiteral(
  value: CanonicalJsonValue,
): "closed" | "excluded" | "open" {
  return isRecord(value) ? "open" : "excluded";
}

function intersectAdmission(
  left: "closed" | "excluded" | "open",
  right: "closed" | "excluded" | "open",
): "closed" | "excluded" | "open" {
  if (left === "excluded" || right === "excluded") return "excluded";
  if (left === "closed" || right === "closed") return "closed";
  return "open";
}

function unionAdmission(
  left: "closed" | "excluded" | "open",
  right: "closed" | "excluded" | "open",
): "closed" | "excluded" | "open" {
  if (left === "open" || right === "open") return "open";
  if (left === "closed" || right === "closed") return "closed";
  return "excluded";
}

function assertSchemaFieldNameArray(
  value: CanonicalJsonValue | undefined,
  location: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new TypeError(`${location} must be an array`);
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      throw new TypeError(`${location} must contain only strings`);
    }
    if (forbiddenFieldName(candidate)) {
      throw new TypeError(`forbidden field ${candidate} at ${location}`);
    }
  }
}

function assertDependentRequiredNames(
  value: CanonicalJsonValue | undefined,
  location: string,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new TypeError(`${location} must be an object`);
  for (const [name, required] of Object.entries(value)) {
    if (forbiddenFieldName(name)) {
      throw new TypeError(`forbidden field ${name} at ${location}`);
    }
    assertSchemaFieldNameArray(required, `${location}.${name}`);
  }
}

function resolvePointer(
  root: CanonicalJsonValue,
  reference: string,
): CanonicalJsonValue {
  if (reference === "#") return root;
  if (!reference.startsWith("#/"))
    throw new TypeError(`unsupported local reference ${reference}`);
  let value = root;
  for (const encoded of reference.slice(2).split("/")) {
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token))
        throw new TypeError(`invalid array pointer ${reference}`);
      value = value[Number(token)];
    } else if (isRecord(value) && token in value) {
      value = value[token];
    } else {
      throw new TypeError(`unresolved local reference ${reference}`);
    }
    if (value === undefined)
      throw new TypeError(`unresolved local reference ${reference}`);
  }
  return value;
}

function verifyConformanceFixtures(
  index: PackageIndex,
  definition: TakoformDefinition,
  payloads: ReadonlyMap<string, Uint8Array>,
): void {
  let desiredValidator: InterpretedDraft202012Validator;
  let observedValidator: InterpretedDraft202012Validator;
  let outputValidator: InterpretedDraft202012Validator | undefined;
  try {
    desiredValidator = new InterpretedDraft202012Validator(
      definition.desiredSchema,
    );
    observedValidator = new InterpretedDraft202012Validator(
      definition.observedSchema,
    );
    if (definition.outputSchema !== undefined) {
      outputValidator = new InterpretedDraft202012Validator(
        definition.outputSchema,
      );
    }
  } catch (error) {
    throw new TypeError("Form Definition schemas cannot be prepared", {
      cause: error,
    });
  }
  for (const fixture of definition.conformanceFixtures ?? []) {
    assertJsonFixture(index, fixture.desiredPath, fixture.name, "desired");
    const desiredBytes = payloads.get(fixture.desiredPath);
    if (!desiredBytes)
      throw new TypeError(`fixture ${fixture.name} desiredPath is missing`);
    const desired = parseCanonicalJson(desiredBytes);
    assertFixtureValidationBudget(
      definition.desiredSchema,
      desired,
      `${fixture.name} desired`,
    );
    if (!desiredValidator.validate(desired)) {
      throw new TypeError(
        `fixture ${fixture.name} does not satisfy desiredSchema`,
      );
    }
    if (fixture.observedPath) {
      assertJsonFixture(index, fixture.observedPath, fixture.name, "observed");
      const observedBytes = payloads.get(fixture.observedPath);
      if (!observedBytes)
        throw new TypeError(`fixture ${fixture.name} observedPath is missing`);
      const observed = parseCanonicalJson(observedBytes);
      assertFixtureValidationBudget(
        definition.observedSchema,
        observed,
        `${fixture.name} observed`,
      );
      if (!observedValidator.validate(observed)) {
        throw new TypeError(
          `fixture ${fixture.name} does not satisfy observedSchema`,
        );
      }
    }
    if (fixture.outputPath) {
      if (
        definition.outputSchema === undefined ||
        outputValidator === undefined
      ) {
        throw new TypeError(
          `fixture ${fixture.name} declares outputPath without outputSchema`,
        );
      }
      assertJsonFixture(index, fixture.outputPath, fixture.name, "output");
      const outputBytes = payloads.get(fixture.outputPath);
      if (!outputBytes)
        throw new TypeError(`fixture ${fixture.name} outputPath is missing`);
      const output = parseCanonicalJson(outputBytes);
      assertFixtureValidationBudget(
        definition.outputSchema,
        output,
        `${fixture.name} output`,
      );
      if (!outputValidator.validate(output)) {
        throw new TypeError(
          `fixture ${fixture.name} does not satisfy outputSchema`,
        );
      }
    }
  }
  for (const fixture of definition.negativeConformanceFixtures ?? []) {
    assertJsonFixture(index, fixture.inputPath, fixture.name, fixture.stage);
    const inputBytes = payloads.get(fixture.inputPath);
    if (!inputBytes) {
      throw new TypeError(
        `negative fixture ${fixture.name} inputPath is missing`,
      );
    }
    if (fixture.expectedFailure !== "schema_validation_failed") {
      throw new TypeError(
        `negative fixture ${fixture.name} has unsupported expectedFailure ${fixture.expectedFailure}`,
      );
    }
    const selected =
      fixture.stage === "desired"
        ? { schema: definition.desiredSchema, validator: desiredValidator }
        : fixture.stage === "observed"
          ? { schema: definition.observedSchema, validator: observedValidator }
          : definition.outputSchema !== undefined &&
              outputValidator !== undefined
            ? { schema: definition.outputSchema, validator: outputValidator }
            : undefined;
    if (selected === undefined) {
      throw new TypeError(
        `negative fixture ${fixture.name} stage ${fixture.stage} has no schema`,
      );
    }
    const input = parseCanonicalJson(inputBytes);
    assertFixtureValidationBudget(
      selected.schema,
      input,
      `${fixture.name} ${fixture.stage}`,
    );
    if (selected.validator.validate(input)) {
      throw new TypeError(
        `negative fixture ${fixture.name} unexpectedly passed ${fixture.stage} validation`,
      );
    }
  }
}

function assertJsonFixture(
  index: PackageIndex,
  path: string,
  name: string,
  role: string,
): void {
  if (
    index.files.find((entry) => entry.path === path)?.mediaType !==
    "application/json"
  ) {
    throw new TypeError(
      `fixture ${name} ${role} payload must use application/json`,
    );
  }
}

function lifecycleOperations(
  capabilities: readonly string[],
  status: string,
): FormOperation[] {
  const result: FormOperation[] = [];
  for (const capability of capabilities) {
    if (
      capability === "create" ||
      capability === "read" ||
      capability === "update" ||
      capability === "delete" ||
      capability === "import" ||
      capability === "refresh"
    ) {
      result.push(capability);
    }
  }
  // Pre-separation compatibility packages used `observe` as the combined
  // read/refresh capability. Preserve only that historical candidate meaning;
  // standard/deprecated definitions must declare read and refresh explicitly.
  if (
    status === "compatibility-candidate" &&
    capabilities.includes("observe")
  ) {
    if (!capabilities.includes("read")) result.push("read");
    if (!capabilities.includes("refresh")) result.push("refresh");
  }
  return [...new Set(result)];
}

function definitionMetadata(definition: TakoformDefinition): JsonObject {
  return {
    takoform: {
      status: definition.status,
      ...(definition.immutableFields
        ? { immutableFields: [...definition.immutableFields] }
        : {}),
      ...(definition.interfaces
        ? {
            interfaces:
              definition.interfaces as unknown as JsonObject["interfaces"],
          }
        : {}),
    },
  };
}

function rejectForbiddenDefinitionContent(
  value: CanonicalJsonValue,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, position) =>
      rejectForbiddenDefinitionContent(entry, `${path}[${position}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFieldName(key))
      throw new TypeError(`forbidden field ${key} at ${path}`);
    rejectForbiddenDefinitionContent(child, `${path}.${key}`);
  }
}

const FORBIDDEN_TOKENS = new Set([
  "credential",
  "credentials",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passphrase",
  "passphrases",
  "token",
  "tokens",
  "authorization",
  "authorizations",
  "bearer",
  "bearers",
  "oauth",
  "oauths",
  "cookie",
  "cookies",
  "operator",
  "operators",
  "account",
  "accounts",
  "target",
  "targets",
  "capacity",
  "capacities",
  "provider",
  "providers",
  "backend",
  "backends",
  "implementation",
  "implementations",
  "region",
  "regions",
  "zone",
  "zones",
  "placement",
  "placements",
  "price",
  "prices",
  "pricing",
  "pricings",
  "sku",
  "skus",
  "billing",
  "billings",
  "invoice",
  "invoices",
  "payment",
  "payments",
  "currency",
  "currencies",
  "tax",
  "taxes",
  "quota",
  "quotas",
  "sla",
  "slas",
  "subscription",
  "subscriptions",
  "entitlement",
  "entitlements",
  "binary",
  "binaries",
  "code",
  "codes",
  "exec",
  "execs",
  "executable",
  "executables",
  "command",
  "commands",
  "script",
  "scripts",
  "bytecode",
  "bytecodes",
  "wasm",
  "wasms",
  "adapter",
  "adapters",
  "plugin",
  "plugins",
]);
const FORBIDDEN_NORMALIZED = new Set([
  "credential",
  "credentials",
  "credentialid",
  "credentialids",
  "credentialref",
  "credentialrefs",
  "credentialname",
  "credentialvalue",
  "secret",
  "secrets",
  "secretid",
  "secretids",
  "secretref",
  "secretrefs",
  "secretname",
  "secretvalue",
  "password",
  "passwords",
  "passphrase",
  "apikey",
  "apikeyid",
  "apikeyref",
  "apikeyvalue",
  "privatekey",
  "privatekeyid",
  "privatekeyref",
  "privatekeypem",
  "sshkey",
  "sshprivatekey",
  "signingkey",
  "token",
  "tokens",
  "tokenid",
  "tokenref",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "authorization",
  "authorizationheader",
  "authheader",
  "bearer",
  "oauth",
  "serviceoffering",
  "serviceofferings",
  "serviceofferingid",
  "backendmanager",
  "managerid",
  "manageridentifier",
  "oauthclient",
  "oauthclientid",
  "oauthclientsecret",
  "oidcclientsecret",
  "sessioncookie",
  "sessiontoken",
  "connectionstring",
  "cookie",
  "cookies",
  "operator",
  "operators",
  "operatorid",
  "operatorpolicy",
  "account",
  "accounts",
  "accountid",
  "target",
  "targets",
  "targetid",
  "targetpool",
  "targetpoolid",
  "poolid",
  "capacity",
  "activecapacity",
  "regioncapacity",
  "provider",
  "providerid",
  "providername",
  "providerconfig",
  "backend",
  "backendid",
  "implementationid",
  "selectedimplementation",
  "region",
  "regions",
  "regionid",
  "zone",
  "zones",
  "zoneid",
  "placement",
  "price",
  "prices",
  "pricing",
  "priceid",
  "unitprice",
  "monthlyprice",
  "sku",
  "skus",
  "billing",
  "billingplan",
  "billingaccount",
  "invoice",
  "invoices",
  "invoiceid",
  "payment",
  "payments",
  "paymentid",
  "paymentmethod",
  "paymentmethods",
  "currency",
  "currencies",
  "currencycode",
  "tax",
  "taxes",
  "taxcode",
  "taxrate",
  "quota",
  "quotas",
  "sla",
  "slapolicy",
  "servicelevelagreement",
  "supportpolicy",
  "subscription",
  "subscriptions",
  "entitlement",
  "entitlements",
  "binary",
  "code",
  "exec",
  "executable",
  "command",
  "commands",
  "script",
  "scripts",
  "sourcecode",
  "runtimecode",
  "validationcode",
  "adapter",
  "adaptercode",
  "bytecode",
  "webassembly",
  "wasm",
  "plugin",
  "plugins",
]);

const FORBIDDEN_FIELD_SEQUENCES = [
  ["api", "key"],
  ["private", "key"],
  ["ssh", "key"],
  ["signing", "key"],
  ["service", "offering"],
  ["backend", "manager"],
  ["manager", "id"],
  ["manager", "identifier"],
] as const;
const FORBIDDEN_COMPOUND_BASES = [
  "apikey",
  "privatekey",
  "sshkey",
  "sshprivatekey",
  "signingkey",
  "serviceoffering",
  "backendmanager",
  "managerid",
  "manageridentifier",
] as const;
const FORBIDDEN_COMPOUND_QUALIFIERS = new Set([
  "id",
  "ids",
  "identifier",
  "identifiers",
  "ref",
  "refs",
  "name",
  "names",
  "value",
  "values",
  "pem",
  "material",
  "fingerprint",
  "header",
  "path",
  "file",
  "config",
  "configuration",
  "label",
  "labels",
]);

function forbiddenFieldName(value: string): boolean {
  const normalized = value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  if (FORBIDDEN_NORMALIZED.has(normalized)) return true;
  const tokens = splitFieldTokens(value);
  if (tokens.some((token) => FORBIDDEN_TOKENS.has(token))) return true;
  for (const singular of FORBIDDEN_COMPOUND_BASES) {
    for (const base of [singular, `${singular}s`]) {
      if (normalized === base) return true;
      if (
        normalized.startsWith(base) &&
        FORBIDDEN_COMPOUND_QUALIFIERS.has(normalized.slice(base.length))
      ) {
        return true;
      }
    }
  }
  return FORBIDDEN_FIELD_SEQUENCES.some((sequence) =>
    tokens.some(
      (_, start) =>
        start + sequence.length <= tokens.length &&
        sequence.every((wanted, offset) =>
          matchesCompoundToken(tokens[start + offset], wanted),
        ),
    ),
  );
}

function splitFieldTokens(value: string): string[] {
  return value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{L}])(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})([\p{L}])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function matchesCompoundToken(actual: string, singular: string): boolean {
  if (actual === singular) return true;
  if (singular === "id") return actual === "ids";
  if (singular === "identifier") return actual === "identifiers";
  if (singular === "key") return actual === "keys";
  if (singular === "manager") return actual === "managers";
  if (singular === "offering") return actual === "offerings";
  return false;
}

function assertSchema(
  validator: StaticSchemaValidator,
  value: CanonicalJsonValue,
  label: string,
): void {
  if (validator(value)) return;
  const detail = validator.errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new TypeError(
    `${label} does not satisfy the Takoform schema${detail ? `: ${detail}` : ""}`,
  );
}

function assertTextPayload(bytes: Uint8Array, path: string): void {
  if (bytes.includes(0)) throw new TypeError(`payload ${path} contains NUL`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`payload ${path} is not UTF-8 text`, { cause: error });
  }
}

function payloadLimit(mediaType: string): number {
  if (mediaType === FORM_DEFINITION_MEDIA_TYPE) return MAX_DEFINITION_BYTES;
  if (JSON_MEDIA_TYPES.has(mediaType)) return MAX_JSON_BYTES;
  return MAX_FILE_BYTES;
}

function validateMediaType(path: string, mediaType: string): void {
  const suffix = extension(path);
  const valid =
    mediaType === FORM_DEFINITION_MEDIA_TYPE ||
    mediaType === "application/schema+json" ||
    mediaType === "application/json"
      ? suffix === ".json"
      : mediaType === "text/markdown"
        ? suffix === ".md" || suffix === ".markdown"
        : mediaType === "text/plain"
          ? suffix === ".txt"
          : false;
  if (!valid) {
    throw new TypeError(
      `payload ${path} extension does not match ${mediaType}`,
    );
  }
}

function decodeBase64(
  value: string,
  label: string,
  maxBytes: number,
): Uint8Array {
  if (
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new TypeError(`${label} is not valid base64`, { cause: error });
  }
  if (
    (value.endsWith("==") &&
      (BASE64_ALPHABET.indexOf(value[value.length - 3]) & 0b1111) !== 0) ||
    (value.endsWith("=") &&
      !value.endsWith("==") &&
      (BASE64_ALPHABET.indexOf(value[value.length - 2]) & 0b11) !== 0)
  ) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  if (binary.length > maxBytes)
    throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validPackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    PACKAGE_PATH_RE.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function escapePointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function isRecord(
  value: CanonicalJsonValue | unknown,
): value is Readonly<Record<string, CanonicalJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
