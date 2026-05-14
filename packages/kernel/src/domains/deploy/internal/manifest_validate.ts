// Authoring-surface validation phase for the public deploy manifest.
//
// All `validate*` helpers live here. They throw `TypeError` with a
// path-prefixed message on rejection, matching the existing behaviour
// callers depend on. The validation phase is invoked by:
//   - `validatePublicDeployManifest` (lint-only)
//   - `resolvePublicDeployManifest` (lint + override-merge return)
//   - `compileManifestToAppSpec` (lint then compile)

import type {
  PublicComponentBindingSpec,
  PublicComputeSpec,
  PublicDeployManifest,
  PublicOutputSpec,
  PublicResourceSpec,
  PublicRouteSpec,
} from "../types.ts";
import {
  assertKnownFields,
  IMAGE_DIGEST_PATTERN,
  isRecord,
  isSafeRepositoryRelativePath,
  isStringArray,
  namedCollectionEntries,
  normalizedEnvNameSet,
  normalizeEnvName,
  validateStringRecord,
} from "./manifest_common.ts";
import {
  inferComputeType,
  outputContractRefFor,
  resourceContractRefFor,
  runtimeContractRefFor,
} from "./contract_refs.ts";
import {
  isHttpRouteProtocol,
  isPortProtocol,
  isQueueRouteProtocol,
  normalizeRouteMethods,
  normalizeRoutePort,
  normalizeRouteProtocol,
  portForCompute,
  routeMethodsOverlap,
} from "./route_helpers.ts";
import { resourceBindingsByComputeFor, resourceBindingsFor } from "./resource_bindings.ts";

interface ValidateManifestOptions {
  autoHostnameAvailable?: boolean;
  localDevelopment?: boolean;
}

const COMPUTE_FIELDS = new Set([
  "type",
  "image",
  "port",
  "entrypoint",
  "command",
  "args",
  "env",
  "depends",
  "bindings",
  "requirements",
  "icon",
  "readiness",
  "containers",
  "scaling",
  "dockerfile",
  "healthCheck",
  "volumes",
]);

const ATTACHED_CONTAINER_FIELDS = new Set([
  "image",
  "port",
  "env",
  "healthCheck",
  "volumes",
  "scaling",
  "bindings",
  "depends",
  "dockerfile",
  "cloudflare",
  "cloudflare.container",
]);

const CLOUDFLARE_CONTAINER_FIELDS = new Set([
  "className",
  "binding",
  "instanceType",
  "maxInstances",
  "name",
  "imageBuildContext",
  "imageVars",
  "rolloutActiveGracePeriod",
  "rolloutStepPercentage",
  "migrationTag",
  "sqlite",
]);

const RESOURCE_FIELDS = new Set([
  "type",
  "plan",
  "env",
  "bindings",
  "bind",
  "to",
  "generate",
]);

const ROUTE_FIELDS = new Set([
  "id",
  "target",
  "host",
  "path",
  "protocol",
  "port",
  "methods",
  "source",
  "timeoutMs",
]);

const OUTPUT_FIELDS = new Set([
  "name",
  "type",
  "from",
  "display",
  "auth",
  "outputs",
  "spec",
]);

const BINDING_FIELDS = new Set(["from", "inject"]);
const BINDING_FROM_FIELDS = new Set([
  "resource",
  "output",
  "secret",
  "providerOutput",
  "field",
  "access",
  "request",
  "optional",
]);

export function validateManifestShape(
  manifest: PublicDeployManifest,
  options: ValidateManifestOptions = {},
): void {
  const compute = manifest.compute ?? {};
  const computeNames = new Set(Object.keys(compute));
  validateStringRecord(manifest.env, "env");
  const inheritedEnv = normalizedEnvNameSet(manifest.env ?? {}, "env");
  validateComputeCollection(manifest.compute ?? {});
  validateResources(manifest.resources ?? {}, computeNames);
  const routeEntries = validateRoutes(manifest.routes ?? {}, compute);
  validateOutputs(manifest.outputs ?? {}, routeEntries);
  const resourceBindingsByCompute = resourceBindingsByComputeFor(
    manifest.resources ?? {},
    computeNames,
    new Set(),
  );
  for (const [name, compute] of Object.entries(manifest.compute ?? {})) {
    const merged: Record<string, PublicComponentBindingSpec> = {
      ...(compute.bindings ?? {}),
      ...(resourceBindingsByCompute.get(name) ?? {}),
    };
    validateBindings(
      `compute.${name}`,
      merged,
      compute.env ?? {},
      inheritedEnv,
      options,
    );
    validateAttachedContainerBindings(name, compute, inheritedEnv, options);
  }
}

function validateComputeCollection(
  compute: Record<string, PublicComputeSpec>,
): void {
  for (const [name, spec] of Object.entries(compute)) {
    if (!isRecord(spec)) {
      throw new TypeError(`compute.${name} must be an object`);
    }
    assertKnownFields(spec, COMPUTE_FIELDS, `compute.${name}`);
    validateStringRecord(spec.env, `compute.${name}.env`);
    if (spec.type !== undefined && typeof spec.type !== "string") {
      throw new TypeError(`compute.${name}.type must be string`);
    }
    if (spec.image !== undefined) {
      validateServiceImage(name, spec);
    }
    if (spec.depends !== undefined && !isStringArray(spec.depends)) {
      throw new TypeError(`compute.${name}.depends must be string array`);
    }
    const runtimeContractRef = computeRuntimeContractRef(name, spec);
    if (spec.containers !== undefined) {
      if (runtimeContractRef !== "runtime.js-worker@v1") {
        throw new TypeError(`compute.${name}.containers is worker-only`);
      }
      validateAttachedContainers(name, spec.containers);
    }
    if (spec.bindings !== undefined) {
      validateBindingShape(`compute.${name}.bindings`, spec.bindings);
    }
  }
}

function validateBindingShape(
  pathPrefix: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new TypeError(`${pathPrefix} must be object`);
  }
  for (const [name, spec] of Object.entries(value)) {
    const path = `${pathPrefix}.${name}`;
    if (!isRecord(spec)) {
      throw new TypeError(`${path} must be object`);
    }
    assertKnownFields(spec, BINDING_FIELDS, path);
    if (!isRecord(spec.from)) {
      throw new TypeError(`${path}.from must be object`);
    }
    assertKnownFields(spec.from, BINDING_FROM_FIELDS, `${path}.from`);
    const sourceKeys = [
      "resource",
      "output",
      "secret",
      "providerOutput",
    ]
      .filter(
        (key) =>
          typeof (spec.from as Record<string, unknown>)[key] === "string",
      );
    if (sourceKeys.length !== 1) {
      throw new TypeError(
        `${path}.from must declare exactly one of resource | output | secret | providerOutput`,
      );
    }
    if (!isRecord(spec.inject)) {
      throw new TypeError(`${path}.inject must be object`);
    }
    if (
      typeof (spec.inject as Record<string, unknown>).mode !== "string" ||
      typeof (spec.inject as Record<string, unknown>).target !== "string"
    ) {
      throw new TypeError(`${path}.inject requires mode and target strings`);
    }
  }
}

function computeRuntimeContractRef(
  name: string,
  spec: PublicComputeSpec,
): string {
  return runtimeContractRefFor(spec.type ?? inferComputeType(name, spec));
}

function validateAttachedContainers(
  computeName: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new TypeError(`compute.${computeName}.containers must be object`);
  }
  for (const [containerName, container] of Object.entries(value)) {
    const path = `compute.${computeName}.containers.${containerName}`;
    if (!isRecord(container)) {
      throw new TypeError(`${path} must be object`);
    }
    assertKnownFields(container, ATTACHED_CONTAINER_FIELDS, path);
    validateStringRecord(container.env, `${path}.env`);
    if (container.depends !== undefined && !isStringArray(container.depends)) {
      throw new TypeError(`${path}.depends must be string array`);
    }
    if (container.bindings !== undefined) {
      validateBindingShape(`${path}.bindings`, container.bindings);
    }
    validateAttachedContainerImage(path, container);
  }
}

function validateAttachedContainerImage(
  path: string,
  container: Record<string, unknown>,
): void {
  const port = container.port;
  if (
    typeof port !== "number" || !Number.isInteger(port) || port < 1 ||
    port > 65535
  ) {
    throw new TypeError(`${path}.port must be integer 1..65535`);
  }

  const cloudflareContainer = cloudflareContainerMetadata(container, path);
  if (typeof container.image !== "string" || container.image.length === 0) {
    throw new TypeError(`${path}.image must be digest-pinned with sha256`);
  }
  if (IMAGE_DIGEST_PATTERN.test(container.image)) return;
  if (cloudflareContainer && isSafeRepositoryRelativePath(container.image)) {
    return;
  }
  throw new TypeError(`${path}.image must be digest-pinned with sha256`);
}

function cloudflareContainerMetadata(
  container: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  const dotted = container["cloudflare.container"];
  const nested = isRecord(container.cloudflare)
    ? container.cloudflare.container
    : undefined;
  if (dotted !== undefined && nested !== undefined) {
    throw new TypeError(
      `${path} must not include both cloudflare.container forms`,
    );
  }
  const metadata = dotted ?? nested;
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) {
    throw new TypeError(`${path}.cloudflare.container must be object`);
  }
  assertKnownFields(
    metadata,
    CLOUDFLARE_CONTAINER_FIELDS,
    `${path}.cloudflare.container`,
  );
  if (
    typeof metadata.className !== "string" || metadata.className.length === 0
  ) {
    throw new TypeError(
      `${path}.cloudflare.container.className must be string`,
    );
  }
  return metadata;
}

function validateServiceImage(name: string, spec: PublicComputeSpec): void {
  if (
    typeof spec.image !== "string" || !IMAGE_DIGEST_PATTERN.test(spec.image)
  ) {
    throw new TypeError(
      `compute.${name}.image must be digest-pinned with sha256`,
    );
  }
  const port = spec.port;
  if (
    port === undefined || !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new TypeError(`compute.${name}.port must be integer 1..65535`);
  }
}

function validateResources(
  resources: Record<string, PublicResourceSpec>,
  computeNames: Set<string>,
): void {
  for (const [name, spec] of Object.entries(resources)) {
    if (!isRecord(spec)) {
      throw new TypeError(`resource.${name} must be an object`);
    }
    assertKnownFields(spec, RESOURCE_FIELDS, `resource.${name}`);
    if (typeof spec.type !== "string" || spec.type.length === 0) {
      throw new TypeError(`resource.${name}.type must be string`);
    }
    resourceContractRefFor(spec.type);
    validateStringRecord(spec.env, `resource.${name}.env`);
    for (const binding of resourceBindingsFor(name, spec)) {
      if (!computeNames.has(binding.compute)) {
        throw new TypeError(
          `resource.${name}.bindings references unknown compute '${binding.compute}'`,
        );
      }
    }
  }
}

function validateRoutes(
  routes: Record<string, PublicRouteSpec> | PublicRouteSpec[],
  compute: Record<string, PublicComputeSpec>,
): Map<string, PublicRouteSpec> {
  const computeNames = new Set(Object.keys(compute));
  const byName = new Map<string, PublicRouteSpec>();
  const seen: {
    readonly name: string;
    readonly target: string;
    readonly host?: string;
    readonly path?: string;
    readonly methods?: readonly string[];
  }[] = [];
  for (const [name, route] of namedCollectionEntries(routes, "route")) {
    if (byName.has(name)) {
      throw new TypeError(`route.${name} duplicates route id`);
    }
    if (!isRecord(route)) throw new TypeError(`route.${name} must be object`);
    assertKnownFields(route, ROUTE_FIELDS, `route.${name}`);
    const target = route.target;
    if (typeof target !== "string" || target.length === 0) {
      throw new TypeError(`route.${name} requires target compute`);
    }
    if (!computeNames.has(target)) {
      throw new TypeError(
        `route.${name} references unknown compute '${target}'`,
      );
    }
    if (route.source !== undefined && typeof route.source !== "string") {
      throw new TypeError(`route.${name}.source must be string`);
    }
    const protocol = normalizeRouteProtocol(route.protocol);
    const isHttpRoute = isHttpRouteProtocol(protocol);
    const isPortRoute = isPortProtocol(protocol);
    const isQueueRoute = isQueueRouteProtocol(protocol);
    if (isHttpRoute && typeof route.path !== "string") {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if (route.path !== undefined && typeof route.path !== "string") {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if (route.path !== undefined && !route.path.startsWith("/")) {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if ((isPortRoute || isQueueRoute) && route.path !== undefined) {
      throw new TypeError(
        `route.${name}.path is only valid for http/https routes`,
      );
    }
    if (!isQueueRoute && route.source !== undefined) {
      throw new TypeError(
        `route.${name}.source is only valid for queue routes`,
      );
    }
    const port = normalizeRoutePort(name, route.port);
    if (
      isPortRoute && port === undefined &&
      portForCompute(compute[target]) === undefined
    ) {
      throw new TypeError(
        `route.${name}.port or compute.${target}.port is required for ${protocol} routes`,
      );
    }
    if (isQueueRoute && port !== undefined) {
      throw new TypeError(
        `route.${name}.port is only valid for http/https/tcp/udp routes`,
      );
    }
    const methods = normalizeRouteMethods(name, route.methods);
    if (!isHttpRoute && methods !== undefined) {
      throw new TypeError(
        `route.${name}.methods is only valid for http/https routes`,
      );
    }
    if (isHttpRoute) {
      for (const previous of seen) {
        if (
          previous.target === target && previous.host === route.host &&
          previous.path === route.path &&
          routeMethodsOverlap(previous.methods, methods)
        ) {
          throw new TypeError(
            `route.${name} duplicates target/path with route.${previous.name}`,
          );
        }
      }
      seen.push({ name, target, host: route.host, path: route.path, methods });
    }
    byName.set(name, route);
  }
  return byName;
}

function validateOutputs(
  outputs: Record<string, PublicOutputSpec> | PublicOutputSpec[],
  routes: Map<string, PublicRouteSpec>,
): void {
  for (const [name, output] of namedCollectionEntries(outputs, "output")) {
    if (!isRecord(output)) {
      throw new TypeError(`output.${name} must be object`);
    }
    assertKnownFields(output, OUTPUT_FIELDS, `output.${name}`);
    if (Array.isArray(outputs) && !output.name) {
      throw new TypeError(`output.${name}.name is required`);
    }
    if (typeof output.type !== "string" || output.type.length === 0) {
      throw new TypeError(`output.${name}.type must be string`);
    }
    outputContractRefFor(output.type);
    const routeRefs = outputRouteRefs(output);
    if (routeRefs.length === 0) {
      throw new TypeError(
        `output.${name} requires outputs.*.routeRef`,
      );
    }
    for (const routeRef of routeRefs) {
      const route = routes.get(routeRef);
      if (!route) {
        throw new TypeError(
          `output.${name} references unknown route '${routeRef}'`,
        );
      }
    }
  }
}

function outputRouteRefs(output: PublicOutputSpec): string[] {
  const refs: string[] = [];
  if (isRecord(output.outputs)) {
    for (const item of Object.values(output.outputs)) {
      if (!isRecord(item)) continue;
      const routeRef = item.routeRef;
      if (typeof routeRef === "string" && routeRef.length > 0) {
        refs.push(routeRef);
      }
    }
  }
  return refs;
}

function validateBindings(
  pathPrefix: string,
  bindings: Record<string, PublicComponentBindingSpec>,
  localEnv: Record<string, string>,
  inheritedEnv: Set<string>,
  options: ValidateManifestOptions,
): void {
  const injectedEnvNames = new Set(inheritedEnv);
  for (const name of normalizedEnvNameSet(localEnv, `${pathPrefix}.env`)) {
    if (injectedEnvNames.has(name)) {
      throw new TypeError(`${pathPrefix}.env collides with env '${name}'`);
    }
    injectedEnvNames.add(name);
  }
  for (const [bindingName, spec] of Object.entries(bindings)) {
    const path = `${pathPrefix}.bindings.${bindingName}`;
    validateBuiltinOutputRequest(path, spec, options);
    const inject = spec.inject;
    if (inject.mode === "env") {
      const normalized = normalizeEnvName(
        inject.target,
        `${path}.inject.target`,
      );
      if (injectedEnvNames.has(normalized)) {
        throw new TypeError(
          `${path}.inject collides with env '${normalized}'`,
        );
      }
      injectedEnvNames.add(normalized);
    }
  }
}

function validateAttachedContainerBindings(
  computeName: string,
  compute: PublicComputeSpec,
  inheritedEnv: Set<string>,
  options: ValidateManifestOptions,
): void {
  if (!isRecord(compute.containers)) return;
  for (const [containerName, container] of Object.entries(compute.containers)) {
    if (!isRecord(container)) continue;
    const bindings = isRecord(container.bindings)
      ? container.bindings as Record<string, PublicComponentBindingSpec>
      : {};
    validateBindings(
      `compute.${computeName}.containers.${containerName}`,
      bindings,
      isRecord(container.env) ? container.env as Record<string, string> : {},
      inheritedEnv,
      options,
    );
  }
}

function validateBuiltinOutputRequest(
  path: string,
  spec: PublicComponentBindingSpec,
  options: ValidateManifestOptions,
): void {
  const from = spec.from as { output?: string; request?: unknown };
  if (from.output === "takosumi.api-key") {
    if (!isRecord(from.request)) {
      throw new TypeError(`${path}.from.request is required`);
    }
    assertKnownFields(
      from.request,
      new Set(["scopes"]),
      `${path}.from.request`,
    );
    if (!isStringArray(from.request.scopes)) {
      throw new TypeError(`${path}.from.request.scopes must be string array`);
    }
  }
  if (from.output === "takosumi.oauth-client") {
    if (!isRecord(from.request)) {
      throw new TypeError(`${path}.from.request is required`);
    }
    assertKnownFields(
      from.request,
      new Set(["redirectUris", "scopes", "clientName", "metadata"]),
      `${path}.from.request`,
    );
    if (!isStringArray(from.request.redirectUris)) {
      throw new TypeError(
        `${path}.from.request.redirectUris must be string array`,
      );
    }
    for (const [index, redirectUri] of from.request.redirectUris.entries()) {
      validateOAuthRedirectUri(
        `${path}.from.request.redirectUris[${index}]`,
        redirectUri,
        options,
      );
    }
    if (!isStringArray(from.request.scopes)) {
      throw new TypeError(`${path}.from.request.scopes must be string array`);
    }
    if (from.request.metadata !== undefined) {
      if (!isRecord(from.request.metadata)) {
        throw new TypeError(`${path}.from.request.metadata must be object`);
      }
      assertKnownFields(
        from.request.metadata,
        new Set(["logoUri", "tosUri", "policyUri"]),
        `${path}.from.request.metadata`,
      );
    }
  }
}

function validateOAuthRedirectUri(
  path: string,
  redirectUri: string,
  options: ValidateManifestOptions,
): void {
  if (redirectUri.startsWith("/") && !redirectUri.startsWith("//")) {
    if (options.autoHostnameAvailable === true) return;
    throw new TypeError(
      `${path} relative path requires auto hostname context`,
    );
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new TypeError(`${path} must be HTTPS absolute URL or relative path`);
  }
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" && options.localDevelopment === true &&
    isLocalhostName(url.hostname)
  ) {
    return;
  }
  throw new TypeError(`${path} must be HTTPS absolute URL`);
}

function isLocalhostName(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost");
}
