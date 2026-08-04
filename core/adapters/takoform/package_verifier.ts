import {
  portableTypeForShapeKind,
  type FormInterfaceDescriptor,
  type FormOperation,
  type FormRef,
  type JsonObject,
  type JsonValue,
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
import forbiddenVocabularyDocument from "./schemas/forbidden-vocabulary.v0.json" with { type: "json" };
import {
  type StaticSchemaValidator,
  validateTakoformFormDefinition,
  validateTakoformPackageIndex,
  validateTakoformPackageIndexV1Alpha2,
} from "./json_schema_2020.ts";
import {
  assertDraft202012Schema,
  InterpretedDraft202012Validator,
} from "../../shared/json-schema/draft_2020.ts";

export const TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE =
  "application/vnd.takosumi.takoform-package-install.v1+json";

const FORM_DEFINITION_MEDIA_TYPE =
  "application/vnd.takoform.form-definition.v1+json";
// The install envelope is a takosumi-internal in-memory transport bound. The
// remaining limits mirror the portable takoform contract exactly
// (formpackage/verify.go), so one signed package gets one verdict everywhere.
const MAX_ENVELOPE_BYTES = 32 << 20;
const MAX_INDEX_BYTES = 4 << 20;
const MAX_DEFINITION_BYTES = 4 << 20;
const MAX_JSON_BYTES = 16 << 20;
const MAX_PAYLOAD_BYTES = 64 << 20;
const MAX_PACKAGE_BYTES = 256 << 20;
const MAX_PACKAGE_FILES = 1024;
const MAX_SCHEMA_PROOF_OPS = 4096;
const MAX_SCHEMA_PROOF_DEPTH = 64;
const MAX_SCHEMA_VALIDATION_WORK = 16_384;
const MAX_CONFORMANCE_FIXTURES = 32;
const PORTABLE_MAP_KEY_PATTERN = "^[A-Za-z][A-Za-z0-9._-]{0,63}$";
const PORTABLE_MAP_POLICY_KEY = "x-takoform-fieldPolicy";
const PORTABLE_MAP_POLICY_VALUE = "portable-data-only-v1";
const PACKAGE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
// Windows reserves these device names in every directory, with or without an
// extension; a package listing one cannot be extracted on that platform.
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 10 }, (_, digit) => `com${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `lpt${digit}`),
]);
// Draft 2020-12 treats unknown keywords as ignorable annotations; portable
// schemas fail closed instead so one definition cannot validate differently
// across hosts. Keep byte-identical to the takoform verifier allowlist.
const PORTABLE_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "$comment",
  "properties",
  "additionalProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "items",
  "prefixItems",
  "contains",
  "unevaluatedItems",
  "unevaluatedProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "type",
  "const",
  "enum",
  "required",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "x-takoform-fieldPolicy",
]);
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
  readonly packageVersion?: string;
  readonly formRef: TakoformFormRef;
  readonly definitionPath: string;
  readonly files: readonly PackageFile[];
}

interface TakoformFormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
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

interface TakoformInterfaceInput {
  readonly name: string;
  readonly source: string;
  readonly pointer?: string;
  readonly value?: CanonicalJsonValue;
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
    readonly resourceUriInput?: string;
    readonly document?: CanonicalJsonValue;
    readonly documentSchema?: CanonicalJsonValue;
    readonly inputs?: readonly TakoformInterfaceInput[];
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
 * Legacy and content-addressed v1alpha2
 * contract. The internal envelope is transport only; package and FormRef
 * identity remain the signed canonical Takoform index and definition.
 */
export class TakoformDataOnlyPackageVerifier implements FormPackageVerifier {
  readonly id: string;

  constructor(
    private readonly signatureVerifier: TakoformPackageSignatureVerifier,
  ) {
    this.id = `takoform.form-package.v1alpha1-v1alpha2+${signatureVerifier.id}`;
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
    const packageIndexValidator = packageIndexSchemaValidator(indexValue);
    assertSchema(packageIndexValidator, indexValue, "package-index.json");
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
      formRef: internalFormRef(index.formRef),
      displayName: definition.title,
      ...(definition.description
        ? { description: definition.description }
        : {}),
      operations: lifecycleOperations(definition.lifecycleCapabilities),
      desiredSchema: structuredClone(
        definition.desiredSchema,
      ) as unknown as JsonObject,
      metadata: definitionMetadata(definition),
      ...(definition.interfaces?.length
        ? { interfaceDescriptors: verifiedInterfaceDescriptors(definition) }
        : {}),
    };
    return { packageDigest, definitions: [verifiedDefinition] };
  }
}

function packageIndexSchemaValidator(
  value: CanonicalJsonValue,
): StaticSchemaValidator {
  if (!isRecord(value)) {
    throw new TypeError("package-index.json must be an object");
  }
  if (value.apiVersion === "packages.forms.takoform.com/v1alpha1") {
    return validateTakoformPackageIndex;
  }
  if (value.apiVersion === "packages.forms.takoform.com/v1alpha2") {
    return validateTakoformPackageIndexV1Alpha2;
  }
  throw new TypeError(
    `unsupported Form Package apiVersion ${String(value.apiVersion)}`,
  );
}

function verifyDefinitionSemantics(definition: TakoformDefinition): void {
  const conformanceFixtures = definition.conformanceFixtures ?? [];
  if (conformanceFixtures.length > MAX_CONFORMANCE_FIXTURES) {
    throw new TypeError(
      `Form Definition has ${conformanceFixtures.length} conformance fixtures; maximum is ${MAX_CONFORMANCE_FIXTURES}`,
    );
  }
  const negativeFixtures = definition.negativeConformanceFixtures ?? [];
  if (negativeFixtures.length > MAX_CONFORMANCE_FIXTURES) {
    throw new TypeError(
      `Form Definition has ${negativeFixtures.length} negative conformance fixtures; maximum is ${MAX_CONFORMANCE_FIXTURES}`,
    );
  }
  const interfaces = new Set<string>();
  for (const [position, descriptor] of (
    definition.interfaces ?? []
  ).entries()) {
    const key = `${descriptor.name}@${descriptor.version}`;
    if (interfaces.has(key)) {
      throw new TypeError(`duplicate Interface ${key}`);
    }
    interfaces.add(key);
    verifyInterfaceInputs(
      key,
      descriptor.resourceUriInput,
      descriptor.inputs ?? [],
    );
    if (descriptor.documentSchema !== undefined) {
      let validateDocument: InterpretedDraft202012Validator;
      try {
        validateDocument = new InterpretedDraft202012Validator(
          descriptor.documentSchema,
          `interfaces[${position}].documentSchema`,
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
  for (const fixture of conformanceFixtures) {
    if (fixtureNames.has(fixture.name)) {
      throw new TypeError(`duplicate conformance fixture name ${fixture.name}`);
    }
    fixtureNames.add(fixture.name);
  }
  for (const fixture of negativeFixtures) {
    if (fixtureNames.has(fixture.name)) {
      throw new TypeError(`duplicate conformance fixture name ${fixture.name}`);
    }
    fixtureNames.add(fixture.name);
  }
}

/**
 * Enforces the deterministic Interface input mapping grammar exactly like the
 * takoform verifier (formpackage validateInterfaceInputs): every input name is
 * unique, a literal carries its own value and never a pointer, and every other
 * source reads through an optional pointer and never carries a value.
 */
function verifyInterfaceInputs(
  interfaceKey: string,
  resourceUriInput: string | undefined,
  inputs: readonly TakoformInterfaceInput[],
): void {
  const names = new Set<string>();
  let resourceUriMatches = 0;
  let resourceUriInputs = 0;
  for (const input of inputs) {
    if (names.has(input.name)) {
      throw new TypeError(
        `Interface ${interfaceKey} has duplicate input ${input.name}`,
      );
    }
    names.add(input.name);
    if (input.source === "literal") {
      if (input.value === undefined) {
        throw new TypeError(
          `Interface ${interfaceKey} input ${input.name} is a literal without a value`,
        );
      }
      if (input.pointer !== undefined && input.pointer !== "") {
        throw new TypeError(
          `Interface ${interfaceKey} input ${input.name} is a literal and must not carry a pointer`,
        );
      }
      continue;
    }
    if (input.source === "resource_uri") {
      resourceUriInputs++;
      if (input.pointer !== undefined || input.value !== undefined) {
        throw new TypeError(
          `Interface ${interfaceKey} input ${input.name} uses resource_uri and must not carry a pointer or value`,
        );
      }
      if (input.name === resourceUriInput) {
        resourceUriMatches++;
      }
    }
    if (input.value !== undefined) {
      throw new TypeError(
        `Interface ${interfaceKey} input ${input.name} carries a value with source ${input.source}; only a literal may`,
      );
    }
  }
  if (
    resourceUriInput !== undefined &&
    (resourceUriMatches !== 1 || resourceUriInputs !== 1)
  ) {
    throw new TypeError(
      `Interface ${interfaceKey} resourceUriInput ${resourceUriInput} must name exactly one resource_uri input`,
    );
  }
  if (resourceUriInput === undefined && resourceUriInputs !== 0) {
    throw new TypeError(
      `Interface ${interfaceKey} has a resource_uri input without resourceUriInput`,
    );
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
    ...(descriptor.resourceUriInput
      ? { resourceUriInput: descriptor.resourceUriInput }
      : {}),
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
  const foldedPaths = new Map<string, string>([
    ["package-index.json", "package-index.json"],
  ]);
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
    const folded = file.path.toLowerCase();
    const collision = foldedPaths.get(folded);
    if (collision !== undefined) {
      throw new TypeError(
        `package paths ${collision} and ${file.path} collide on case-insensitive filesystems`,
      );
    }
    foldedPaths.set(folded, file.path);
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

function internalFormRef(ref: TakoformFormRef): FormRef {
  const type = portableTypeForShapeKind(ref.kind);
  if (type === undefined) {
    throw new TypeError(
      `FormRef kind ${ref.kind} cannot be projected to a portable type`,
    );
  }
  return {
    type,
    version: ref.definitionVersion,
    schemaDigest: ref.schemaDigest,
  };
}

type ObjectAdmission = "open" | "closed" | "excluded";

interface SchemaProofResult {
  readonly mode: ObjectAdmission;
  readonly maxDepth: number;
}

/**
 * Verifies one inline portable schema exactly like the takoform reference
 * verifier (formpackage compileInlineSchema): the document-wide fragment-only
 * reference scan first, then the fail-closed object-closure proof plus the
 * worst-case validation-work bound, then a Draft 2020-12 compile check.
 */
function verifyPortableSchema(value: CanonicalJsonValue, label: string): void {
  verifyFragmentOnlyReferences(value, label);
  validatePortableSchemaStructure(value, label);
  try {
    assertDraft202012Schema(value, label);
    new InterpretedDraft202012Validator(value, label);
  } catch (error) {
    throw new TypeError(`${label} is not a compilable Draft 2020-12 schema`, {
      cause: error,
    });
  }
}

/**
 * Walks the ENTIRE schema document — including annotation values such as
 * default/examples and literal const/enum members — rejecting `$dynamicRef`
 * everywhere and any `$ref` whose string value is not `#` or `#/...`.
 */
function verifyFragmentOnlyReferences(
  value: CanonicalJsonValue,
  location: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      verifyFragmentOnlyReferences(child, `${location}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === "$dynamicRef") {
      throw new TypeError(
        `${childLocation} is forbidden because dynamic resolution cannot be proven closed`,
      );
    }
    if (
      key === "$ref" &&
      (typeof child !== "string" || (child !== "#" && !child.startsWith("#/")))
    ) {
      throw new TypeError(
        `${childLocation} must be a document-local fragment using the root or a JSON Pointer; network, package-path, anchor, and dynamic references are forbidden`,
      );
    }
    verifyFragmentOnlyReferences(child, childLocation);
  }
}

/**
 * Proves at every schema node that object values are either impossible or
 * constrained by an explicit closed object or the exact reviewed typed-map
 * escape. JSON Schema's permissive empty/implicit schemas otherwise accept
 * arbitrary objects, so uncertainty fails closed. Exact port of the takoform
 * portableSchemaValidator including memoized depth accounting and the shared
 * node/ref operation budget.
 */
function validatePortableSchemaStructure(
  root: CanonicalJsonValue,
  label: string,
): void {
  const memo = new Map<
    string,
    { state: "visiting" } | { state: "done"; result: SchemaProofResult }
  >();
  let operations = 0;
  const consumeOperation = (location: string, operation: string): void => {
    operations++;
    if (operations > MAX_SCHEMA_PROOF_OPS) {
      throw new TypeError(
        `${location} portable schema closure proof exceeds combined node/ref operation budget ${MAX_SCHEMA_PROOF_OPS} while proving ${operation}`,
      );
    }
  };

  const validate = (
    node: CanonicalJsonValue,
    location: string,
    pointer: string,
    depth: number,
  ): SchemaProofResult => {
    if (depth > MAX_SCHEMA_PROOF_DEPTH) {
      throw new TypeError(
        `${location} portable schema closure proof exceeds depth limit ${MAX_SCHEMA_PROOF_DEPTH}`,
      );
    }
    const known = memo.get(pointer);
    if (known !== undefined) {
      if (known.state === "visiting") {
        throw new TypeError(
          `${location} cyclic schema references are not accepted by the portable closure proof`,
        );
      }
      if (depth + known.result.maxDepth > MAX_SCHEMA_PROOF_DEPTH) {
        throw new TypeError(
          `${location} portable schema closure proof exceeds depth limit ${MAX_SCHEMA_PROOF_DEPTH}`,
        );
      }
      return known.result;
    }
    consumeOperation(location, "schema node");
    memo.set(pointer, { state: "visiting" });
    const result = validateUncached(node, location, pointer, depth);
    if (depth + result.maxDepth > MAX_SCHEMA_PROOF_DEPTH) {
      throw new TypeError(
        `${location} portable schema closure proof exceeds depth limit ${MAX_SCHEMA_PROOF_DEPTH}`,
      );
    }
    memo.set(pointer, { state: "done", result });
    return result;
  };

  const validateUncached = (
    node: CanonicalJsonValue,
    location: string,
    pointer: string,
    depth: number,
  ): SchemaProofResult => {
    if (node === true) {
      throw new TypeError(
        `${location} boolean true schema can admit arbitrary object values`,
      );
    }
    if (node === false) return { mode: "excluded", maxDepth: 0 };
    if (!isRecord(node)) {
      throw new TypeError(
        `${location} must be a JSON Schema object or boolean`,
      );
    }
    if ("patternProperties" in node) {
      throw new TypeError(
        `${location} patternProperties is forbidden; use the reviewed typed-map escape`,
      );
    }
    if ("dependencies" in node) {
      throw new TypeError(
        `${location} legacy dependencies is forbidden; use dependentRequired or dependentSchemas`,
      );
    }
    for (const keyword of [
      "contentEncoding",
      "contentMediaType",
      "contentSchema",
    ]) {
      if (keyword in node) {
        throw new TypeError(
          `${location}.${keyword} is forbidden because portable Forms do not decode or transform embedded content`,
        );
      }
    }
    if (
      node.$schema !== undefined &&
      node.$schema !== "https://json-schema.org/draft/2020-12/schema"
    ) {
      throw new TypeError(`${location}.$schema must remain Draft 2020-12`);
    }
    for (const keyword of [
      "$id",
      "$anchor",
      "$dynamicAnchor",
      "$recursiveAnchor",
      "$recursiveRef",
      "$vocabulary",
    ]) {
      if (keyword in node) {
        throw new TypeError(
          `${location}.${keyword} is forbidden because alternate or recursive resolution scopes cannot be proven closed`,
        );
      }
    }
    for (const keyword of Object.keys(node)) {
      if (!PORTABLE_SCHEMA_KEYWORDS.has(keyword)) {
        throw new TypeError(
          `${location}.${keyword} is not in the closed portable schema keyword vocabulary; portable schemas fail closed on unknown keywords`,
        );
      }
    }
    if (node.format !== undefined && typeof node.format !== "string") {
      throw new TypeError(
        `${location}.format must be a string; portable validation treats format as an annotation only`,
      );
    }

    const hasProperties = node.properties !== undefined;
    if (hasProperties && !isRecord(node.properties)) {
      throw new TypeError(`${location}.properties must be an object`);
    }
    if (isRecord(node.properties)) {
      for (const name of Object.keys(node.properties)) {
        if (forbiddenFieldName(name)) {
          throw new TypeError(
            `forbidden field ${name} at ${location}.properties`,
          );
        }
      }
    }
    assertSchemaFieldNameArray(node.required, `${location}.required`);
    assertDependentRequiredNames(
      node.dependentRequired,
      `${location}.dependentRequired`,
    );

    const hasObjectType = schemaTypeIncludes(node.type, "object");
    if (schemaTypeIncludes(node.type, "array") && node.items === undefined) {
      throw new TypeError(
        `${location} array schema must declare items so nested object admission is proven closed`,
      );
    }
    let mode: ObjectAdmission = "open";
    if (hasObjectType) {
      validateExplicitObjectClosure(node, hasProperties, location);
      mode = "closed";
    } else if (node.type !== undefined) {
      mode = "excluded";
    } else if (hasObjectKeywords(node)) {
      throw new TypeError(
        `${location} uses object keywords without explicit type=object and closed additionalProperties`,
      );
    }

    let maxDepth = 0;
    const recordChild = (result: SchemaProofResult): void => {
      if (result.maxDepth + 1 > maxDepth) maxDepth = result.maxDepth + 1;
    };

    for (const keyword of [
      "$defs",
      "definitions",
      "properties",
      "dependentSchemas",
    ]) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!isRecord(children)) {
        throw new TypeError(`${location}.${keyword} must be an object`);
      }
      for (const [name, child] of Object.entries(children)) {
        recordChild(
          validate(
            child,
            `${location}.${keyword}.${name}`,
            appendSchemaPointer(pointer, keyword, name),
            depth + 1,
          ),
        );
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
    ]) {
      const child = node[keyword];
      if (
        child === undefined ||
        (keyword === "additionalProperties" && child === false)
      ) {
        continue;
      }
      recordChild(
        validate(
          child,
          `${location}.${keyword}`,
          appendSchemaPointer(pointer, keyword),
          depth + 1,
        ),
      );
    }

    const compoundModes = new Map<string, readonly ObjectAdmission[]>();
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children) || children.length === 0) {
        throw new TypeError(
          `${location}.${keyword} must be a non-empty array of schemas`,
        );
      }
      const modes = children.map((child, position) => {
        const childResult = validate(
          child,
          `${location}.${keyword}[${position}]`,
          appendSchemaPointer(pointer, keyword, String(position)),
          depth + 1,
        );
        recordChild(childResult);
        return childResult.mode;
      });
      compoundModes.set(keyword, modes);
    }

    if (node.const !== undefined) {
      mode = intersectAdmission(mode, admissionForLiteral(node.const));
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        throw new TypeError(`${location}.enum must be a non-empty array`);
      }
      mode = intersectAdmission(
        mode,
        node.enum.reduce<ObjectAdmission>(
          (current, candidate) =>
            unionAdmission(current, admissionForLiteral(candidate)),
          "excluded",
        ),
      );
    }
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string") {
        throw new TypeError(`${location}.$ref must be a string`);
      }
      consumeOperation(`${location}.$ref`, "local reference");
      const target = resolveLocalSchemaReference(
        root,
        node.$ref,
        `${location}.$ref`,
      );
      const targetResult = validate(
        target.value,
        `${location}.$ref(${node.$ref})`,
        target.pointer,
        depth + 1,
      );
      recordChild(targetResult);
      mode = intersectAdmission(mode, targetResult.mode);
    }
    const allOf = compoundModes.get("allOf");
    if (allOf) {
      mode = intersectAdmission(
        mode,
        allOf.reduce<ObjectAdmission>(
          (current, candidate) => intersectAdmission(current, candidate),
          "open",
        ),
      );
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      const modes = compoundModes.get(keyword);
      if (!modes) continue;
      mode = intersectAdmission(
        mode,
        modes.reduce<ObjectAdmission>(
          (current, candidate) => unionAdmission(current, candidate),
          "excluded",
        ),
      );
    }
    if (mode === "open") {
      throw new TypeError(
        `${location} can admit arbitrary object values; declare a non-object type, a closed object, or the reviewed typed-map escape`,
      );
    }
    return { mode, maxDepth };
  };

  validate(root, label, "#", 0);
  const validationWork = estimateSchemaValidationWork(root, label);
  if (validationWork > MAX_SCHEMA_VALIDATION_WORK) {
    throw new TypeError(
      `${label} worst-case fixture validation work exceeds ${MAX_SCHEMA_VALIDATION_WORK} schema evaluations`,
    );
  }
}

/**
 * The exact explicit-closure rule for `type: object` schemas: either
 * `additionalProperties: false`, or the reviewed typed-map escape whose
 * `propertyNames` is exactly the three-key portable map policy.
 */
function validateExplicitObjectClosure(
  schema: Readonly<Record<string, CanonicalJsonValue>>,
  hasProperties: boolean,
  location: string,
): void {
  const additional = schema.additionalProperties;
  if (typeof additional === "boolean") {
    if (additional) {
      throw new TypeError(
        `${location} object schema must set additionalProperties to false or use the reviewed typed-map escape`,
      );
    }
    return;
  }
  if (isRecord(additional)) {
    if (
      hasProperties ||
      schema.required !== undefined ||
      schema.dependentRequired !== undefined ||
      schema.dependentSchemas !== undefined ||
      schema.unevaluatedProperties !== undefined
    ) {
      throw new TypeError(
        `${location} typed map must be a pure map without fixed or dependent properties`,
      );
    }
    validatePortableMapPropertyNames(
      schema.propertyNames,
      `${location}.propertyNames`,
    );
    return;
  }
  throw new TypeError(
    `${location} object schema must set additionalProperties to false or a typed schema`,
  );
}

function validatePortableMapPropertyNames(
  value: CanonicalJsonValue | undefined,
  location: string,
): void {
  if (!isRecord(value)) {
    throw new TypeError(
      `${location} must declare the reviewed portable map-key policy`,
    );
  }
  if (
    Object.keys(value).length !== 3 ||
    value.type !== "string" ||
    value.pattern !== PORTABLE_MAP_KEY_PATTERN ||
    value[PORTABLE_MAP_POLICY_KEY] !== PORTABLE_MAP_POLICY_VALUE
  ) {
    throw new TypeError(
      `${location} must be exactly type=string, pattern=${PORTABLE_MAP_KEY_PATTERN}, and ${PORTABLE_MAP_POLICY_KEY}=${PORTABLE_MAP_POLICY_VALUE}`,
    );
  }
}

function schemaTypeIncludes(
  value: CanonicalJsonValue | undefined,
  wanted: string,
): boolean {
  if (typeof value === "string") return value === wanted;
  return Array.isArray(value) && value.includes(wanted);
}

/**
 * Estimates a conservative upper bound for one schema-only validation pass,
 * saturating at the shared work cap. It intentionally expands the cost of
 * every local $ref occurrence even though target analysis is memoized: the
 * JSON Schema evaluator may revisit a shared target for every edge in an
 * allOf/anyOf/oneOf DAG. Definitions themselves do not execute unless
 * referenced.
 */
function estimateSchemaValidationWork(
  root: CanonicalJsonValue,
  label: string,
): number {
  const memo = new Map<
    string,
    { state: "visiting" } | { state: "done"; work: number }
  >();
  const estimate = (node: CanonicalJsonValue, pointer: string): number => {
    const known = memo.get(pointer);
    if (known !== undefined) {
      if (known.state === "visiting") {
        throw new TypeError(`${label} cyclic schema reference at ${pointer}`);
      }
      return known.work;
    }
    memo.set(pointer, { state: "visiting" });
    if (typeof node === "boolean") {
      memo.set(pointer, { state: "done", work: 1 });
      return 1;
    }
    if (!isRecord(node)) {
      throw new TypeError(
        `${label} schema node ${pointer} is not an object or boolean`,
      );
    }
    let work = 1;
    const addChild = (
      child: CanonicalJsonValue,
      childPointer: string,
    ): void => {
      work = saturatingSchemaWorkAdd(work, estimate(child, childPointer));
    };
    for (const keyword of ["properties", "dependentSchemas"]) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!isRecord(children)) {
        throw new TypeError(`${pointer}.${keyword} must be an object`);
      }
      for (const [name, child] of Object.entries(children)) {
        addChild(child, appendSchemaPointer(pointer, keyword, name));
        if (work > MAX_SCHEMA_VALIDATION_WORK) break;
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
    ]) {
      const child = node[keyword];
      if (child === undefined) continue;
      addChild(child, appendSchemaPointer(pointer, keyword));
      if (work > MAX_SCHEMA_VALIDATION_WORK) break;
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = node[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children)) {
        throw new TypeError(
          `schema node ${pointer}/${keyword} is not an array`,
        );
      }
      for (const [position, child] of children.entries()) {
        addChild(
          child,
          appendSchemaPointer(pointer, keyword, String(position)),
        );
        if (work > MAX_SCHEMA_VALIDATION_WORK) break;
      }
    }
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string") {
        throw new TypeError(`schema node ${pointer}/$ref is not a string`);
      }
      const target = resolveLocalSchemaReference(
        root,
        node.$ref,
        `${label} ${pointer}/$ref`,
      );
      addChild(target.value, target.pointer);
    }
    memo.set(pointer, { state: "done", work });
    return work;
  };
  return estimate(root, "#");
}

function saturatingSchemaWorkAdd(left: number, right: number): number {
  const limit = MAX_SCHEMA_VALIDATION_WORK + 1;
  if (left >= limit || right >= limit || left > limit - right) return limit;
  return left + right;
}

function assertFixtureValidationBudget(
  schema: CanonicalJsonValue,
  instance: CanonicalJsonValue,
  label: string,
): void {
  const work = estimateSchemaInstanceValidationWork(schema, instance);
  if (work > MAX_SCHEMA_VALIDATION_WORK) {
    throw new TypeError(
      `conformance fixture ${label} worst-case validation work exceeds ${MAX_SCHEMA_VALIDATION_WORK} schema evaluations`,
    );
  }
}

/**
 * Charges schema work against the concrete fixture instance. Schema proof and
 * structural work alone cannot bound repeatable keywords: items, contains,
 * additionalProperties, and propertyNames can evaluate the same
 * shared-reference DAG once per array element or object property. Canonical
 * schema/instance pointers plus the value/property-name role are memoized so
 * analysis stays linear, while each repeated edge still adds the cached child
 * work to the saturating total that guards the real validator call.
 */
function estimateSchemaInstanceValidationWork(
  root: CanonicalJsonValue,
  instance: CanonicalJsonValue,
): number {
  const memo = new Map<
    string,
    { state: "visiting" } | { state: "done"; work: number }
  >();
  const estimate = (
    schemaValue: CanonicalJsonValue,
    schemaPointer: string,
    instanceValue: CanonicalJsonValue,
    instancePointer: string,
    instanceRole: string,
  ): number => {
    const key = JSON.stringify([schemaPointer, instancePointer, instanceRole]);
    const known = memo.get(key);
    if (known !== undefined) {
      if (known.state === "visiting") {
        throw new TypeError(
          `cyclic schema reference at ${schemaPointer} for instance ${instancePointer}`,
        );
      }
      return known.work;
    }
    memo.set(key, { state: "visiting" });
    if (typeof schemaValue === "boolean") {
      memo.set(key, { state: "done", work: 1 });
      return 1;
    }
    if (!isRecord(schemaValue)) {
      throw new TypeError(
        `schema node ${schemaPointer} is not an object or boolean`,
      );
    }

    let work = 1;
    const addChildWithRole = (
      childSchema: CanonicalJsonValue,
      childSchemaPointer: string,
      childInstance: CanonicalJsonValue,
      childInstancePointer: string,
      childInstanceRole: string,
    ): void => {
      if (work > MAX_SCHEMA_VALIDATION_WORK) return;
      work = saturatingSchemaWorkAdd(
        work,
        estimate(
          childSchema,
          childSchemaPointer,
          childInstance,
          childInstancePointer,
          childInstanceRole,
        ),
      );
    };
    const addChild = (
      childSchema: CanonicalJsonValue,
      childSchemaPointer: string,
      childInstance: CanonicalJsonValue,
      childInstancePointer: string,
    ): void => {
      addChildWithRole(
        childSchema,
        childSchemaPointer,
        childInstance,
        childInstancePointer,
        instanceRole,
      );
    };

    if (
      schemaValue.properties !== undefined &&
      !isRecord(schemaValue.properties)
    ) {
      throw new TypeError(`${schemaPointer}.properties must be an object`);
    }
    if (
      schemaValue.dependentSchemas !== undefined &&
      !isRecord(schemaValue.dependentSchemas)
    ) {
      throw new TypeError(
        `${schemaPointer}.dependentSchemas must be an object`,
      );
    }
    const properties = isRecord(schemaValue.properties)
      ? schemaValue.properties
      : undefined;
    const objectInstance = isRecord(instanceValue) ? instanceValue : undefined;
    if (objectInstance && properties) {
      for (const [name, childSchema] of Object.entries(properties)) {
        if (!(name in objectInstance)) continue;
        addChild(
          childSchema,
          appendSchemaPointer(schemaPointer, "properties", name),
          objectInstance[name] as CanonicalJsonValue,
          appendSchemaPointer(instancePointer, name),
        );
      }
    }
    const dependentSchemas = isRecord(schemaValue.dependentSchemas)
      ? schemaValue.dependentSchemas
      : undefined;
    if (objectInstance && dependentSchemas) {
      for (const [name, childSchema] of Object.entries(dependentSchemas)) {
        if (!(name in objectInstance)) continue;
        addChild(
          childSchema,
          appendSchemaPointer(schemaPointer, "dependentSchemas", name),
          instanceValue,
          instancePointer,
        );
      }
    }

    if (objectInstance) {
      if (schemaValue.additionalProperties !== undefined) {
        for (const [name, childInstance] of Object.entries(objectInstance)) {
          if (properties && name in properties) continue;
          addChild(
            schemaValue.additionalProperties,
            appendSchemaPointer(schemaPointer, "additionalProperties"),
            childInstance,
            appendSchemaPointer(instancePointer, name),
          );
        }
      }
      if (schemaValue.propertyNames !== undefined) {
        for (const name of Object.keys(objectInstance)) {
          addChildWithRole(
            schemaValue.propertyNames,
            appendSchemaPointer(schemaPointer, "propertyNames"),
            name,
            appendSchemaPointer(instancePointer, "@propertyName", name),
            "property-name",
          );
        }
      }
      // Evaluation annotations are deliberately not reimplemented here.
      // Applying unevaluatedProperties to every property is a safe upper
      // bound.
      if (schemaValue.unevaluatedProperties !== undefined) {
        for (const [name, childInstance] of Object.entries(objectInstance)) {
          addChild(
            schemaValue.unevaluatedProperties,
            appendSchemaPointer(schemaPointer, "unevaluatedProperties"),
            childInstance,
            appendSchemaPointer(instancePointer, name),
          );
        }
      }
    }

    const arrayInstance = Array.isArray(instanceValue)
      ? instanceValue
      : undefined;
    const prefixItems = Array.isArray(schemaValue.prefixItems)
      ? schemaValue.prefixItems
      : [];
    if (arrayInstance) {
      for (const [index, childSchema] of prefixItems.entries()) {
        if (index >= arrayInstance.length) break;
        addChild(
          childSchema,
          appendSchemaPointer(schemaPointer, "prefixItems", String(index)),
          arrayInstance[index] as CanonicalJsonValue,
          appendSchemaPointer(instancePointer, String(index)),
        );
      }
      if (schemaValue.items !== undefined) {
        for (
          let index = prefixItems.length;
          index < arrayInstance.length;
          index++
        ) {
          addChild(
            schemaValue.items,
            appendSchemaPointer(schemaPointer, "items"),
            arrayInstance[index] as CanonicalJsonValue,
            appendSchemaPointer(instancePointer, String(index)),
          );
        }
      }
      if (schemaValue.contains !== undefined) {
        for (const [index, childInstance] of arrayInstance.entries()) {
          addChild(
            schemaValue.contains,
            appendSchemaPointer(schemaPointer, "contains"),
            childInstance,
            appendSchemaPointer(instancePointer, String(index)),
          );
        }
      }
      // Applying unevaluatedItems to every item safely overestimates
      // evaluation without duplicating the validator's annotation machinery.
      if (schemaValue.unevaluatedItems !== undefined) {
        for (const [index, childInstance] of arrayInstance.entries()) {
          addChild(
            schemaValue.unevaluatedItems,
            appendSchemaPointer(schemaPointer, "unevaluatedItems"),
            childInstance,
            appendSchemaPointer(instancePointer, String(index)),
          );
        }
      }
    }

    for (const keyword of ["not", "if", "then", "else"]) {
      const childSchema = schemaValue[keyword];
      if (childSchema === undefined) continue;
      addChild(
        childSchema,
        appendSchemaPointer(schemaPointer, keyword),
        instanceValue,
        instancePointer,
      );
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const children = schemaValue[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children)) {
        throw new TypeError(
          `schema node ${schemaPointer}/${keyword} is not an array`,
        );
      }
      for (const [index, childSchema] of children.entries()) {
        addChild(
          childSchema,
          appendSchemaPointer(schemaPointer, keyword, String(index)),
          instanceValue,
          instancePointer,
        );
      }
    }
    if (schemaValue.$ref !== undefined) {
      if (typeof schemaValue.$ref !== "string") {
        throw new TypeError(
          `schema node ${schemaPointer}/$ref is not a string`,
        );
      }
      const target = resolveLocalSchemaReference(
        root,
        schemaValue.$ref,
        `schema node ${schemaPointer}/$ref`,
      );
      addChild(target.value, target.pointer, instanceValue, instancePointer);
    }

    memo.set(key, { state: "done", work });
    return work;
  };
  return estimate(root, "#", instance, "#", "value");
}

function hasObjectKeywords(
  schema: Readonly<Record<string, CanonicalJsonValue>>,
): boolean {
  return [
    "properties",
    "required",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "dependentRequired",
    "dependentSchemas",
    "minProperties",
    "maxProperties",
  ].some((key) => key in schema);
}

function admissionForLiteral(value: CanonicalJsonValue): ObjectAdmission {
  return isRecord(value) ? "open" : "excluded";
}

function intersectAdmission(
  left: ObjectAdmission,
  right: ObjectAdmission,
): ObjectAdmission {
  if (left === "excluded" || right === "excluded") return "excluded";
  if (left === "closed" || right === "closed") return "closed";
  return "open";
}

function unionAdmission(
  left: ObjectAdmission,
  right: ObjectAdmission,
): ObjectAdmission {
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

/**
 * Resolves one document-local `$ref`. The JSON Pointer fragment is
 * percent-decoded before token traversal (URI fragments may URI-encode
 * pointer characters), each token is strictly `~0`/`~1`-decoded, and the
 * canonical pointer spelling is returned so equivalent spellings of one
 * target share memoization and cycle state.
 */
function resolveLocalSchemaReference(
  root: CanonicalJsonValue,
  reference: string,
  location: string,
): { readonly value: CanonicalJsonValue; readonly pointer: string } {
  if (reference === "#") return { value: root, pointer: "#" };
  if (!reference.startsWith("#/")) {
    throw new TypeError(
      `${location}: only root or JSON Pointer fragments are supported`,
    );
  }
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch (error) {
    throw new TypeError(`${location}: decode fragment failed`, {
      cause: error,
    });
  }
  let current = root;
  let pointer = "#";
  for (const rawToken of fragment.replace(/^\//u, "").split("/")) {
    const token = decodeJsonPointerToken(rawToken, location);
    pointer = appendSchemaPointer(pointer, token);
    if (isRecord(current)) {
      if (!(token in current)) {
        throw new TypeError(
          `${location}: fragment token ${token} does not exist`,
        );
      }
      current = current[token] as CanonicalJsonValue;
    } else if (Array.isArray(current)) {
      if (token === "-" || (token.length > 1 && token.startsWith("0"))) {
        throw new TypeError(
          `${location}: fragment array token ${token} is invalid`,
        );
      }
      const index = Number(token);
      if (!/^[0-9]+$/u.test(token) || index >= current.length) {
        throw new TypeError(
          `${location}: fragment array token ${token} is out of range`,
        );
      }
      current = current[index] as CanonicalJsonValue;
    } else {
      throw new TypeError(
        `${location}: fragment traverses non-container at ${token}`,
      );
    }
  }
  return { value: current, pointer };
}

function decodeJsonPointerToken(value: string, location: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "~") {
      decoded += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape !== "0" && escape !== "1") {
      throw new TypeError(
        `${location}: fragment contains invalid JSON Pointer escape`,
      );
    }
    decoded += escape === "0" ? "~" : "/";
    index++;
  }
  return decoded;
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
      "desiredSchema",
    );
    observedValidator = new InterpretedDraft202012Validator(
      definition.observedSchema,
      "observedSchema",
    );
    if (definition.outputSchema !== undefined) {
      outputValidator = new InterpretedDraft202012Validator(
        definition.outputSchema,
        "outputSchema",
      );
    }
  } catch (error) {
    throw new TypeError("Form Definition schemas cannot be compiled", {
      cause: error,
    });
  }
  for (const fixture of definition.conformanceFixtures ?? []) {
    assertJsonFixture(index, fixture.desiredPath, fixture.name, "desired");
    const desiredBytes = payloads.get(fixture.desiredPath);
    if (!desiredBytes)
      throw new TypeError(`fixture ${fixture.name} desiredPath is missing`);
    validateFixtureAgainstSchema(
      definition.desiredSchema,
      desiredValidator,
      parseCanonicalJson(desiredBytes),
      `${fixture.name} desired`,
    );
    if (fixture.observedPath) {
      assertJsonFixture(index, fixture.observedPath, fixture.name, "observed");
      const observedBytes = payloads.get(fixture.observedPath);
      if (!observedBytes)
        throw new TypeError(`fixture ${fixture.name} observedPath is missing`);
      validateFixtureAgainstSchema(
        definition.observedSchema,
        observedValidator,
        parseCanonicalJson(observedBytes),
        `${fixture.name} observed`,
      );
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
      validateFixtureAgainstSchema(
        definition.outputSchema,
        outputValidator,
        parseCanonicalJson(outputBytes),
        `${fixture.name} output`,
      );
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
          ? {
              schema: definition.observedSchema,
              validator: observedValidator,
            }
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
    // Exactly like the takoform verifier, any failure — schema validation or
    // the validation-work budget — satisfies a negative fixture.
    let failed = false;
    try {
      validateFixtureAgainstSchema(
        selected.schema,
        selected.validator,
        input,
        `${fixture.name} ${fixture.stage}`,
      );
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new TypeError(
        `negative conformance fixture ${fixture.name} unexpectedly passed ${fixture.stage} validation`,
      );
    }
  }
}

function validateFixtureAgainstSchema(
  schema: CanonicalJsonValue,
  validator: InterpretedDraft202012Validator,
  instance: CanonicalJsonValue,
  label: string,
): void {
  assertFixtureValidationBudget(schema, instance, label);
  if (!validator.validate(instance)) {
    throw new TypeError(
      `conformance fixture ${label} does not satisfy its Form Definition schema: ${validator.errorsText()}`,
    );
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
  if (capabilities.includes("observe")) {
    if (!capabilities.includes("read")) result.push("read");
    if (!capabilities.includes("refresh")) result.push("refresh");
  }
  return [...new Set(result)];
}

function definitionMetadata(definition: TakoformDefinition): JsonObject {
  return {
    takoform: {
      // This is an immutable Definition-document field, not current Form
      // maturity. Runtime operations are derived only from capabilities and
      // the principal-facing Form API deliberately omits this metadata.
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

/**
 * Applies Takoform's pinned portable-data vocabulary to a standalone document.
 * The Interface write facade uses the same verifier rule as signed Form
 * Packages so direct HTTP callers cannot bypass provider-side admission.
 */
export function assertTakoformPortableDataOnly(
  value: CanonicalJsonValue,
  path = "$",
): void {
  rejectForbiddenDefinitionContent(value, path);
}

interface ForbiddenVocabulary {
  readonly normalizedFields: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
  readonly pluralTokens: ReadonlySet<string>;
  readonly tokenSequences: readonly (readonly string[])[];
  readonly compoundBases: readonly string[];
  readonly compoundQualifiers: ReadonlySet<string>;
  readonly sequenceTokenPlurals: Readonly<Record<string, string>>;
}

/**
 * The normative, machine-readable forbidden-field vocabulary, copied
 * byte-exact from the independent takoform project and pinned by
 * schema-provenance.json. The matcher tables are parsed from it, never
 * hand-edited, so the takosumi and takoform verifiers cannot silently drift.
 * Matching stays exact and boundary-delimited: substring matching is unsafe
 * here ("description" contains "script"), plurals are listed rather than
 * derived, and compound bases pair only with reviewed qualifiers.
 */
const FORBIDDEN_VOCABULARY: ForbiddenVocabulary = loadForbiddenVocabulary(
  forbiddenVocabularyDocument,
);

function loadForbiddenVocabulary(document: {
  readonly format: string;
  readonly normalizedFields: readonly string[];
  readonly tokens: readonly string[];
  readonly pluralTokens: readonly string[];
  readonly tokenSequences: readonly (readonly string[])[];
  readonly compoundBases: readonly string[];
  readonly compoundQualifiers: readonly string[];
  readonly sequenceTokenPlurals: Readonly<Record<string, string>>;
}): ForbiddenVocabulary {
  if (document.format !== "takoform.forbidden-vocabulary@v0") {
    throw new TypeError(
      `embedded forbidden vocabulary has wrong format ${document.format}`,
    );
  }
  return {
    normalizedFields: new Set(document.normalizedFields),
    tokens: new Set(document.tokens),
    pluralTokens: new Set(document.pluralTokens),
    tokenSequences: document.tokenSequences,
    compoundBases: document.compoundBases,
    compoundQualifiers: new Set(document.compoundQualifiers),
    sequenceTokenPlurals: document.sequenceTokenPlurals,
  };
}

function forbiddenFieldName(value: string): boolean {
  const normalized = normalizeFieldName(value);
  if (FORBIDDEN_VOCABULARY.normalizedFields.has(normalized)) return true;
  for (const singular of FORBIDDEN_VOCABULARY.compoundBases) {
    for (const base of [singular, `${singular}s`]) {
      if (normalized === base) return true;
      if (
        normalized.startsWith(base) &&
        FORBIDDEN_VOCABULARY.compoundQualifiers.has(
          normalized.slice(base.length),
        )
      ) {
        return true;
      }
    }
  }
  const tokens = splitFieldTokens(value);
  if (
    tokens.some(
      (token) =>
        FORBIDDEN_VOCABULARY.tokens.has(token) ||
        FORBIDDEN_VOCABULARY.pluralTokens.has(token),
    )
  ) {
    return true;
  }
  return FORBIDDEN_VOCABULARY.tokenSequences.some((sequence) =>
    containsTokenSequence(tokens, sequence),
  );
}

function containsTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[],
): boolean {
  if (sequence.length === 0 || tokens.length < sequence.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start++) {
    if (
      sequence.every((wanted, offset) =>
        matchesCompoundToken(tokens[start + offset] ?? "", wanted),
      )
    ) {
      return true;
    }
  }
  return false;
}

function matchesCompoundToken(actual: string, singular: string): boolean {
  if (actual === singular) return true;
  const plural = FORBIDDEN_VOCABULARY.sequenceTokenPlurals[singular];
  return plural !== undefined && actual === plural;
}

function normalizeFieldName(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
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
  return MAX_PAYLOAD_BYTES;
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
    !isCanonicalBase64Shape(value)
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

/**
 * Structural base64 validation as a linear scan. A grouped-quantifier regex
 * is deliberately avoided here: regex engines silently give up on
 * multi-megabyte inputs, which would reject contract-valid large payloads.
 */
function isCanonicalBase64Shape(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let dataLength = value.length;
  while (dataLength > 0 && value[dataLength - 1] === "=") dataLength--;
  if (value.length - dataLength > 2) return false;
  for (let index = 0; index < dataLength; index++) {
    const code = value.charCodeAt(index);
    const alphanumeric =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39);
    if (!alphanumeric && code !== 0x2b && code !== 0x2f) return false;
  }
  return true;
}

function validPackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    PACKAGE_PATH_RE.test(value) &&
    !value.split("/").some((segment) => {
      if (segment === "." || segment === ".." || segment.endsWith(".")) {
        return true;
      }
      const dot = segment.indexOf(".");
      const stem = (dot < 0 ? segment : segment.slice(0, dot)).toLowerCase();
      return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
    })
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

function appendSchemaPointer(pointer: string, ...tokens: string[]): string {
  let result = pointer;
  for (const token of tokens) {
    result += `/${escapePointer(token)}`;
  }
  return result;
}

function escapePointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function isRecord(
  value: CanonicalJsonValue | unknown,
): value is Readonly<Record<string, CanonicalJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
