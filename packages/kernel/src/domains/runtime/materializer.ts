import type {
  RuntimeDesiredState,
  RuntimeMaterializationInput,
  RuntimeResourceSpec,
  RuntimeRouteBindingSpec,
  RuntimeWorkloadSpec,
} from "./types.ts";

export interface RuntimeMaterializer {
  materialize(input: RuntimeMaterializationInput): Promise<RuntimeDesiredState>;
}

export class DefaultRuntimeMaterializer implements RuntimeMaterializer {
  readonly #clock: () => Date;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  materialize(
    input: RuntimeMaterializationInput,
  ): Promise<RuntimeDesiredState> {
    const materializedAt = input.materializedAt ?? this.#clock().toISOString();
    const state: RuntimeDesiredState = Object.freeze({
      id: desiredStateId(input.spaceId, input.groupId, input.activationId),
      spaceId: input.spaceId,
      groupId: input.groupId,
      activationId: input.activationId,
      appName: input.appSpec.name,
      appVersion: input.appSpec.version,
      materializedAt,
      workloads: input.appSpec.components.map((component) =>
        Object.freeze<RuntimeWorkloadSpec>({
          id: runtimeScopedId(input, "workload", component.name),
          spaceId: input.spaceId,
          groupId: input.groupId,
          activationId: input.activationId,
          componentName: component.name,
          runtimeName: `${input.groupId}-${component.name}`,
          type: component.type,
          image: component.image,
          entrypoint: component.entrypoint,
          command: [...(component.command ?? [])],
          args: [...(component.args ?? [])],
          env: { ...input.appSpec.env, ...component.env },
          depends: [...component.depends],
        })
      ),
      resources: input.appSpec.resources.map((resource) =>
        Object.freeze<RuntimeResourceSpec>({
          id: runtimeScopedId(input, "resource", resource.name),
          spaceId: input.spaceId,
          groupId: input.groupId,
          activationId: input.activationId,
          resourceName: resource.name,
          runtimeName: `${input.groupId}-${resource.name}`,
          type: resource.type,
          env: { ...input.appSpec.env, ...resource.env },
        })
      ),
      routes: input.appSpec.routes.map((route) =>
        Object.freeze<RuntimeRouteBindingSpec>({
          id: runtimeScopedId(input, "route", route.name),
          spaceId: input.spaceId,
          groupId: input.groupId,
          activationId: input.activationId,
          routeName: route.name,
          targetComponentName: route.to,
          host: route.host,
          path: route.path,
          protocol: route.protocol,
          port: route.port,
          targetPort: route.targetPort,
          source: route.source,
        })
      ),
    });
    return Promise.resolve(state);
  }
}

export function desiredStateId(
  spaceId: string,
  groupId: string,
  activationId: string,
): string {
  return `${spaceId}:${groupId}:${activationId}`;
}

function runtimeScopedId(
  input: RuntimeMaterializationInput,
  kind: string,
  name: string,
): string {
  return `${
    desiredStateId(input.spaceId, input.groupId, input.activationId)
  }:${kind}:${name}`;
}
