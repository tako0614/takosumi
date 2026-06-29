/**
 * Built-in first-party Capsule module registry.
 *
 * The built-in module set is authored as TypeScript data (see
 * `opentofu-modules/README.md`) and imported statically here. The registry
 * validates every entry once at module load (fail fast on a malformed object)
 * and indexes by `id@version`.
 *
 * The deploy-control domain resolves an InstallConfig-backed module by
 * id+version, validates request inputs against it, runs rootgen, and threads the
 * generated-root payload onto the runner dispatch. The module binding is
 * service-side configuration, not a user-repo manifest requirement.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";
import { firstPartyModuleFilesByTemplateId } from "../../../opentofu-modules/module-files.ts";
import { cloudflareHelloWorkerTemplate } from "../../../providers/cloudflare/modules/cloudflare-hello-worker/template.ts";
import { cloudflareStaticSiteTemplate } from "../../../providers/cloudflare/modules/cloudflare-static-site/template.ts";
import { cloudflareWorkerServiceTemplate } from "../../../providers/cloudflare/modules/cloudflare-worker-service/template.ts";
import { takosumiAiEndpointTemplate } from "../../../providers/takosumi/modules/takosumi-ai-endpoint/template.ts";
import { coreTemplate } from "../../../opentofu-modules/core/template.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { assertValidTemplate } from "./validation.ts";

/** Source-of-truth active built-in module list. Add new first-party modules here. */
const ACTIVE_CATALOG: readonly TemplateDefinition[] = [
  coreTemplate,
  cloudflareHelloWorkerTemplate,
  cloudflareStaticSiteTemplate,
  takosumiAiEndpointTemplate,
];

// Legacy templates are still resolvable for stored pre-v1 rows, but are not
// returned by list() and must not appear as a new install/catalog option.
const LEGACY_CATALOG: readonly TemplateDefinition[] = [
  cloudflareWorkerServiceTemplate,
];

function assertActiveCatalogHasNoBuildDispatch(
  catalog: readonly TemplateDefinition[],
): void {
  for (const template of catalog) {
    if (template.build !== undefined) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `active first-party Capsule module ${template.id}@${template.version} must not define Takosumi-owned build dispatch`,
      );
    }
  }
}

function registryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function buildRegistry(
  catalog: readonly TemplateDefinition[],
): ReadonlyMap<string, TemplateDefinition> {
  const map = new Map<string, TemplateDefinition>();
  for (const template of catalog) {
    assertValidTemplate(template);
    const key = registryKey(template.id, template.version);
    if (map.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `duplicate first-party Capsule module: ${key}`,
      );
    }
    map.set(key, template);
  }
  return map;
}

assertActiveCatalogHasNoBuildDispatch(ACTIVE_CATALOG);
const REGISTRY = buildRegistry([...ACTIVE_CATALOG, ...LEGACY_CATALOG]);

export class TemplateRegistry {
  readonly #catalog: readonly TemplateDefinition[];
  readonly #byKey: ReadonlyMap<string, TemplateDefinition>;

  constructor(
    catalog: readonly TemplateDefinition[] = ACTIVE_CATALOG,
    prebuilt?: ReadonlyMap<string, TemplateDefinition>,
  ) {
    this.#catalog = [...catalog];
    this.#byKey = prebuilt ?? buildRegistry(catalog);
  }

  list(): readonly TemplateDefinition[] {
    return [...this.#catalog];
  }

  get(id: string, version: string): TemplateDefinition | undefined {
    return this.#byKey.get(registryKey(id, version));
  }

  /**
   * Resolves a built-in module, throwing `not_found` when the id+version is unknown.
   * Both id and version are required; there is no implicit "latest" so a stored
   * PlanRun binding always resolves to the exact reviewed module.
   */
  require(id: string, version: string): TemplateDefinition {
    const template = this.get(id, version);
    if (!template) {
      throw new OpenTofuControllerError(
        "not_found",
        `template ${registryKey(id, version)} is not a built-in Capsule module`,
      );
    }
    return template;
  }

  requireModuleFiles(
    id: string,
    version: string,
  ): NonNullable<DispatchGeneratedRoot["moduleFiles"]> {
    this.require(id, version);
    const moduleFiles = firstPartyModuleFilesByTemplateId[id];
    if (!moduleFiles || moduleFiles.length === 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `template ${registryKey(id, version)} has no bundled module files`,
      );
    }
    return moduleFiles.map((file) => ({ ...file }));
  }
}

/** Shared default registry over the built-in first-party module set. */
export const defaultTemplateRegistry = new TemplateRegistry(
  ACTIVE_CATALOG,
  REGISTRY,
);
