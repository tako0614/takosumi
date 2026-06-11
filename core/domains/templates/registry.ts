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
 * build/generatedRoot payload onto the runner dispatch. The module binding is
 * service-side configuration, not a user-repo manifest requirement.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";
import { firstPartyModuleFilesByTemplateId } from "../../../opentofu-modules/module-files.ts";
import { awsS3StorageTemplate } from "../../../opentofu-modules/aws-s3-storage/template.ts";
import { cloudflareR2StorageTemplate } from "../../../opentofu-modules/cloudflare-r2-storage/template.ts";
import { cloudflareStaticSiteTemplate } from "../../../opentofu-modules/cloudflare-static-site/template.ts";
import { cloudflareWorkerServiceTemplate } from "../../../opentofu-modules/cloudflare-worker-service/template.ts";
import { coreTemplate } from "../../../opentofu-modules/core/template.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { assertValidTemplate } from "./validation.ts";

/** Source-of-truth built-in module list. Add new first-party modules here. */
const CATALOG: readonly TemplateDefinition[] = [
  coreTemplate,
  cloudflareR2StorageTemplate,
  cloudflareWorkerServiceTemplate,
  cloudflareStaticSiteTemplate,
  awsS3StorageTemplate,
];

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

const REGISTRY = buildRegistry(CATALOG);

export class TemplateRegistry {
  readonly #byKey: ReadonlyMap<string, TemplateDefinition>;

  constructor(
    catalog: readonly TemplateDefinition[] = CATALOG,
    prebuilt?: ReadonlyMap<string, TemplateDefinition>,
  ) {
    this.#byKey = prebuilt ?? buildRegistry(catalog);
  }

  list(): readonly TemplateDefinition[] {
    return Array.from(this.#byKey.values());
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
export const defaultTemplateRegistry = new TemplateRegistry(CATALOG, REGISTRY);
