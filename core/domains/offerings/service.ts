import type {
  IsoTimestamp,
  Offering,
  OfferingAvailability,
  OfferingAvailabilityReason,
  OfferingCatalog,
  OfferingCatalogReader,
  OfferingContextReference,
  OfferingReference,
  OfferingSelection,
  OfferingSubjectResolution,
  OfferingSubjectReference,
  OfferingSubjectResolver,
} from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAMESPACED_TYPE =
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,126})\/[A-Za-z][A-Za-z0-9._:/-]{0,190}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const FORBIDDEN_KEYS = new Set([
  "backendManager",
  "backendManagerId",
  "capacity",
  "credential",
  "credentialRef",
  "currency",
  "invoice",
  "manager",
  "managerId",
  "payment",
  "price",
  "quota",
  "sku",
  "sla",
  "support",
  "targetCredential",
]);

export interface OfferingServiceOptions {
  readonly catalogs: OfferingCatalogReader;
  readonly resolvers?: readonly OfferingSubjectResolver[];
  readonly now?: () => IsoTimestamp;
}

export class OfferingError extends Error {
  constructor(
    readonly code:
      | "invalid_catalog"
      | "catalog_not_found"
      | "offering_not_found"
      | "offering_unavailable",
    message: string,
    readonly availabilityReason?: OfferingAvailabilityReason,
  ) {
    super(message);
    this.name = "OfferingError";
  }
}

export class OfferingService {
  readonly #catalogs: OfferingCatalogReader;
  readonly #resolvers: ReadonlyMap<string, OfferingSubjectResolver>;
  readonly #now: () => IsoTimestamp;

  constructor(options: OfferingServiceOptions) {
    this.#catalogs = options.catalogs;
    this.#now = options.now ?? (() => new Date().toISOString());
    const resolvers = new Map<string, OfferingSubjectResolver>();
    for (const resolver of options.resolvers ?? []) {
      if (!NAMESPACED_TYPE.test(resolver.subjectType)) {
        throw new TypeError("Offering resolver subjectType must be namespaced");
      }
      if (resolvers.has(resolver.subjectType)) {
        throw new TypeError(
          `duplicate Offering resolver for ${resolver.subjectType}`,
        );
      }
      resolvers.set(resolver.subjectType, resolver);
    }
    this.#resolvers = resolvers;
  }

  async listAvailability(input: {
    readonly catalogId: string;
    readonly catalogVersion: string;
    readonly principalId?: string;
    readonly roles?: readonly string[];
    readonly workspaceId?: string;
    readonly contexts?: readonly OfferingContextReference[];
  }): Promise<readonly OfferingAvailability[]> {
    const catalog = await this.#catalog(input.catalogId, input.catalogVersion);
    const now = this.#now();
    return await Promise.all(
      catalog.offerings.map(async (offering) => {
        const reference = offeringReference(catalog, offering);
        let reason = this.#staticAvailabilityReason({
          catalog,
          offering,
          now,
          principalId: input.principalId,
          roles: input.roles ?? [],
        });
        if (!reason) {
          const resolved = await this.#resolvers
            .get(offering.subject.type)!
            .resolve({
              offering: structuredClone(offering),
              principalId: input.principalId,
              roles: input.roles ?? [],
              workspaceId: input.workspaceId,
              contexts: input.contexts ?? [],
            });
          if (!validReadyResolution(resolved)) reason = "subject_unavailable";
        }
        return {
          reference,
          subject: structuredClone(offering.subject),
          profile: offering.profile,
          region: offering.region,
          maturity: offering.maturity,
          availableToPrincipal: reason === undefined,
          ...(reason ? { reason } : {}),
        } satisfies OfferingAvailability;
      }),
    );
  }

  async resolve(input: {
    readonly reference: OfferingReference;
    readonly principalId?: string;
    readonly roles?: readonly string[];
    readonly workspaceId?: string;
    readonly contexts?: readonly OfferingContextReference[];
  }): Promise<OfferingSelection> {
    const catalog = await this.#catalog(
      input.reference.catalogId,
      input.reference.catalogVersion,
    );
    const offering = catalog.offerings.find(
      (candidate) =>
        candidate.id === input.reference.offeringId &&
        candidate.version === input.reference.offeringVersion,
    );
    if (!offering) {
      throw new OfferingError(
        "offering_not_found",
        "the exact Offering id/version does not exist in this catalog",
      );
    }
    const now = this.#now();
    const reason = this.#staticAvailabilityReason({
      catalog,
      offering,
      now,
      principalId: input.principalId,
      roles: input.roles ?? [],
    });
    if (reason) {
      throw new OfferingError(
        "offering_unavailable",
        `the exact Offering is unavailable: ${reason}`,
        reason,
      );
    }
    const resolver = this.#resolvers.get(offering.subject.type)!;
    const resolved = await resolver.resolve({
      offering: structuredClone(offering),
      principalId: input.principalId,
      roles: input.roles ?? [],
      workspaceId: input.workspaceId,
      contexts: input.contexts ?? [],
    });
    if (!validReadyResolution(resolved)) {
      throw new OfferingError(
        "offering_unavailable",
        "the subject resolver did not return exact ready evidence",
        "subject_unavailable",
      );
    }
    const reference = offeringReference(catalog, offering);
    return {
      reference,
      subject: structuredClone(offering.subject),
      requirements: structuredClone(offering.requirements),
      profile: offering.profile,
      region: offering.region,
      maturity: offering.maturity,
      resolverId: resolved.resolverId,
      resolutionFingerprint: await stableJsonDigest({
        schema: "takosumi.offering-selection.v1",
        reference,
        offering,
        resolverId: resolved.resolverId,
        subjectResolutionFingerprint: resolved.resolutionFingerprint,
      }),
      resolvedAt: now,
    };
  }

  async #catalog(id: string, version: string): Promise<OfferingCatalog> {
    if (!TOKEN.test(id) || !TOKEN.test(version)) {
      throw new OfferingError(
        "catalog_not_found",
        "an exact Offering catalog id/version is required",
      );
    }
    const catalog = await this.#catalogs.getCatalog(id, version);
    if (!catalog) {
      throw new OfferingError(
        "catalog_not_found",
        "the exact Offering catalog does not exist",
      );
    }
    if (catalog.id !== id || catalog.version !== version) {
      throw new OfferingError(
        "invalid_catalog",
        "Offering catalog reader returned a different id/version",
      );
    }
    const problems = offeringCatalogProblems(catalog);
    if (problems.length > 0) {
      throw new OfferingError(
        "invalid_catalog",
        `Offering catalog is invalid: ${problems.join(", ")}`,
      );
    }
    return catalog;
  }

  #staticAvailabilityReason(input: {
    readonly catalog: OfferingCatalog;
    readonly offering: Offering;
    readonly now: IsoTimestamp;
    readonly principalId?: string;
    readonly roles: readonly string[];
  }): OfferingAvailabilityReason | undefined {
    if (Date.parse(input.catalog.effectiveAt) > Date.parse(input.now)) {
      return "catalog_not_effective";
    }
    if (input.offering.status !== "active") return "offering_inactive";
    if (!audienceAllows(input.offering, input.principalId, input.roles)) {
      return "principal_not_allowed";
    }
    const resolver = this.#resolvers.get(input.offering.subject.type);
    if (!resolver) return "resolver_unavailable";
    return undefined;
  }
}

function validReadyResolution(
  value: OfferingSubjectResolution,
): value is Extract<OfferingSubjectResolution, { readonly ready: true }> {
  return (
    value.ready &&
    TOKEN.test(value.resolverId) &&
    SHA256.test(value.resolutionFingerprint)
  );
}

export function offeringCatalogProblems(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (
    !recordWithExactKeys(value, ["id", "version", "effectiveAt", "offerings"])
  ) {
    return ["catalog_envelope_invalid"];
  }
  if (!TOKEN.test(string(value.id)) || !TOKEN.test(string(value.version))) {
    problems.push("catalog_identity_invalid");
  }
  if (!isoTimestamp(value.effectiveAt)) problems.push("effective_at_invalid");
  if (!Array.isArray(value.offerings))
    return [...problems, "offerings_invalid"];

  const identities = new Set<string>();
  value.offerings.forEach((entry, index) => {
    const prefix = `offerings[${index}]`;
    if (
      !recordWithExactKeys(entry, [
        "id",
        "version",
        "subject",
        "requirements",
        "profile",
        "region",
        "maturity",
        "audience",
        "status",
      ])
    ) {
      problems.push(`${prefix}:envelope_invalid`);
      return;
    }
    if (containsForbiddenKey(entry)) {
      problems.push(`${prefix}:commercial_or_private_field_forbidden`);
    }
    const id = string(entry.id);
    const version = string(entry.version);
    if (!TOKEN.test(id) || !TOKEN.test(version)) {
      problems.push(`${prefix}:identity_invalid`);
    } else {
      const identity = `${id}@${version}`;
      if (identities.has(identity))
        problems.push(`${prefix}:duplicate_identity`);
      identities.add(identity);
    }
    if (!subjectReference(entry.subject))
      problems.push(`${prefix}:subject_invalid`);
    if (
      !Array.isArray(entry.requirements) ||
      entry.requirements.some(
        (requirement) => !requirementReference(requirement),
      ) ||
      new Set(entry.requirements.map(requirementKey)).size !==
        entry.requirements.length
    ) {
      problems.push(`${prefix}:requirements_invalid`);
    }
    if (
      !TOKEN.test(string(entry.profile)) ||
      !TOKEN.test(string(entry.region))
    ) {
      problems.push(`${prefix}:placement_projection_invalid`);
    }
    if (entry.maturity !== "stable" && entry.maturity !== "preview") {
      problems.push(`${prefix}:maturity_invalid`);
    }
    if (entry.status !== "active" && entry.status !== "inactive") {
      problems.push(`${prefix}:status_invalid`);
    }
    if (!audience(entry.audience)) problems.push(`${prefix}:audience_invalid`);
  });
  return problems.sort();
}

function audienceAllows(
  offering: Offering,
  principalId: string | undefined,
  roles: readonly string[],
): boolean {
  if (offering.audience.public === true) return true;
  if (
    principalId &&
    (offering.audience.principalIds ?? []).includes(principalId)
  ) {
    return true;
  }
  return roles.some((role) => (offering.audience.roles ?? []).includes(role));
}

function offeringReference(
  catalog: OfferingCatalog,
  offering: Offering,
): OfferingReference {
  return {
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    offeringId: offering.id,
    offeringVersion: offering.version,
  };
}

function subjectReference(value: unknown): value is OfferingSubjectReference {
  return (
    recordWithExactKeys(value, ["type", "ref", "version", "digest"]) &&
    NAMESPACED_TYPE.test(string(value.type)) &&
    boundedText(value.ref, 1024) &&
    boundedText(value.version, 128) &&
    SHA256.test(string(value.digest))
  );
}

function requirementReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["ref", "type", "version"]) &&
    JSON.stringify(keys) !==
      JSON.stringify(["digest", "ref", "type", "version"])
  ) {
    return false;
  }
  return (
    NAMESPACED_TYPE.test(string(value.type)) &&
    boundedText(value.ref, 1024) &&
    boundedText(value.version, 128) &&
    (value.digest === undefined || SHA256.test(string(value.digest)))
  );
}

function requirementKey(value: unknown): string {
  if (!isRecord(value)) return "<invalid>";
  return `${string(value.type)}\u0000${string(value.ref)}\u0000${string(value.version)}\u0000${string(value.digest)}`;
}

function audience(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some(
      (key) => !["principalIds", "public", "roles"].includes(key),
    )
  ) {
    return false;
  }
  if (value.public !== undefined && typeof value.public !== "boolean")
    return false;
  return [value.principalIds, value.roles].every(
    (entries) =>
      entries === undefined ||
      (Array.isArray(entries) &&
        entries.every((entry) => TOKEN.test(string(entry))) &&
        new Set(entries).size === entries.length),
  );
}

function containsForbiddenKey(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key));
}

function recordWithExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
