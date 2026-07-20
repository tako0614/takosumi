import {
  FORM_ACTIVATION_OFFERING_REQUIREMENT_TYPE,
  FORM_HOST_RESOURCE_NAMESPACE_OFFERING_CONTEXT_TYPE,
  SERVICE_FORM_OFFERING_SUBJECT_TYPE,
  installedFormReferenceKey,
  parseFormRefKey,
  type ActorContext,
  type FormActivation,
  type FormAvailability,
  type FormDefinition,
  type FormPackage,
  type InstalledFormReference,
  type OfferingSubjectResolver,
} from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";

export interface FormOfferingRegistryReader {
  getActivation(id: string): Promise<FormActivation | undefined>;
  getDefinition(
    ref: InstalledFormReference["formRef"],
  ): Promise<FormDefinition | undefined>;
  getPackage(digest: string): Promise<FormPackage | undefined>;
}

export interface FormOfferingAvailabilityReader {
  resolveFormOfferingAvailability(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly identity: InstalledFormReference;
    readonly activationId: string;
  }): Promise<FormAvailability>;
}

/**
 * Built-in adapter for the one Service Form subject type. It deliberately
 * consumes the same Form Registry and Resource availability logic as the
 * canonical Resource lifecycle; a catalog row cannot bypass activation,
 * implementation, target, adapter, package, or audience checks.
 */
export class FormOfferingSubjectResolver implements OfferingSubjectResolver {
  readonly subjectType = SERVICE_FORM_OFFERING_SUBJECT_TYPE;
  readonly #forms: FormOfferingRegistryReader;
  readonly #availability: FormOfferingAvailabilityReader;

  constructor(input: {
    readonly forms: FormOfferingRegistryReader;
    readonly availability: FormOfferingAvailabilityReader;
  }) {
    this.#forms = input.forms;
    this.#availability = input.availability;
  }

  async resolve(input: Parameters<OfferingSubjectResolver["resolve"]>[0]) {
    const formRef = parseFormRefKey(input.offering.subject.ref);
    if (
      !formRef ||
      input.offering.subject.type !== this.subjectType ||
      formRef.definitionVersion !== input.offering.subject.version
    ) {
      return unavailable("subject_identity_mismatch");
    }
    const identity: InstalledFormReference = {
      formRef,
      packageDigest: input.offering.subject.digest,
    };
    const activationRequirement = exactActivationRequirement(
      input.offering.requirements,
    );
    if (!activationRequirement) {
      return unavailable("activation_requirement_invalid");
    }
    const resourceNamespaces = input.contexts.filter(
      (context) =>
        context.type === FORM_HOST_RESOURCE_NAMESPACE_OFFERING_CONTEXT_TYPE,
    );
    if (
      resourceNamespaces.length !== 1 ||
      resourceNamespaces[0]!.id.trim() === "" ||
      resourceNamespaces[0]!.id.length > 256
    ) {
      return unavailable("resource_namespace_context_required");
    }
    const resourceSpace = resourceNamespaces[0]!.id;
    const activation = await this.#forms.getActivation(
      activationRequirement.ref,
    );
    if (
      !activation ||
      activation.status !== "active" ||
      String(activation.revision) !== activationRequirement.version ||
      installedFormReferenceKey(activation.identity) !==
        installedFormReferenceKey(identity) ||
      !activationScopeAllows(activation, input.workspaceId, resourceSpace) ||
      !activationAudienceAllows(activation, input.principalId, input.roles)
    ) {
      return unavailable("activation_unavailable");
    }
    const [definitionBefore, packageBefore] = await Promise.all([
      this.#forms.getDefinition(formRef),
      this.#forms.getPackage(identity.packageDigest),
    ]);
    if (
      !definitionBefore ||
      !packageBefore ||
      installedFormReferenceKey(definitionBefore.identity) !==
        installedFormReferenceKey(identity) ||
      packageBefore.status !== "installed"
    ) {
      return unavailable("form_not_installed");
    }

    const availability =
      await this.#availability.resolveFormOfferingAvailability({
        actor: {
          actorAccountId: input.principalId ?? "",
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          roles: [...input.roles],
          requestId: "offering-selection",
        },
        space: resourceSpace,
        identity,
        activationId: activation.id,
      });
    if (
      !availability.availableToPrincipal ||
      availability.deprecated ||
      installedFormReferenceKey(availability.identity) !==
        installedFormReferenceKey(identity)
    ) {
      return unavailable(
        availability.availabilityReason ?? "form_not_executable",
      );
    }

    const [activationAfter, definitionAfter, packageAfter] = await Promise.all([
      this.#forms.getActivation(activation.id),
      this.#forms.getDefinition(formRef),
      this.#forms.getPackage(identity.packageDigest),
    ]);
    const beforeDigest = await stableJsonDigest({
      activation,
      definition: definitionBefore,
      package: packageBefore,
    });
    const afterDigest = await stableJsonDigest({
      activation: activationAfter ?? null,
      definition: definitionAfter ?? null,
      package: packageAfter ?? null,
    });
    if (beforeDigest !== afterDigest) {
      return unavailable("form_evidence_changed");
    }

    return {
      ready: true as const,
      resolverId: "takosumi.service-form.v1",
      resolutionFingerprint: await stableJsonDigest({
        schema: "takosumi.service-form-offering-resolution.v1",
        offering: input.offering,
        activation,
        definition: definitionBefore,
        package: packageBefore,
        availability,
        resourceSpace,
        workspaceId: input.workspaceId ?? null,
      }),
    };
  }
}

function exactActivationRequirement(
  requirements: Parameters<
    OfferingSubjectResolver["resolve"]
  >[0]["offering"]["requirements"],
) {
  if (
    requirements.length !== 1 ||
    requirements[0]?.type !== FORM_ACTIVATION_OFFERING_REQUIREMENT_TYPE ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requirements[0].ref) ||
    !/^[1-9][0-9]*$/u.test(requirements[0].version) ||
    requirements[0].digest !== undefined
  ) {
    return undefined;
  }
  return requirements[0];
}

function activationScopeAllows(
  activation: FormActivation,
  workspaceId: string | undefined,
  resourceSpace: string | undefined,
): boolean {
  if (activation.scope.type === "operator") return true;
  if (activation.scope.type === "workspace") {
    return activation.scope.id === workspaceId;
  }
  return activation.scope.id === resourceSpace;
}

function activationAudienceAllows(
  activation: FormActivation,
  principalId: string | undefined,
  roles: readonly string[],
): boolean {
  if (activation.audience.public === true) return true;
  if (principalId && activation.audience.principalIds?.includes(principalId)) {
    return true;
  }
  return roles.some((role) => activation.audience.roles?.includes(role));
}

function unavailable(reason: string) {
  return { ready: false as const, reason };
}
