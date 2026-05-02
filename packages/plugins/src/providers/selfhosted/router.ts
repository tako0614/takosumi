import { router } from "takosumi-contract";
import { freezeClone } from "./common.ts";

export type SelfHostedRouterKind = "caddy" | "traefik";

export interface SelfHostedRouterConfigWriter {
  write(
    input: SelfHostedRouterConfigWrite,
  ): Promise<SelfHostedRouterConfigWriteResult>;
}

export interface SelfHostedRouterConfigWrite {
  readonly kind: SelfHostedRouterKind;
  readonly path?: string;
  readonly content: string;
  readonly config: router.RouterConfig;
}

export interface SelfHostedRouterConfigWriteResult {
  readonly path?: string;
  readonly revision?: string;
}

export interface SelfHostedRouterConfigAdapterOptions {
  readonly writer: SelfHostedRouterConfigWriter;
  readonly kind?: SelfHostedRouterKind;
  readonly path?: string;
  readonly renderer?: router.RouterConfigRenderer;
  readonly clock?: () => Date;
}

export class SelfHostedRouterConfigAdapter implements router.RouterConfigPort {
  readonly #writer: SelfHostedRouterConfigWriter;
  readonly #kind: SelfHostedRouterKind;
  readonly #path?: string;
  readonly #renderer: router.RouterConfigRenderer;
  readonly #clock: () => Date;

  constructor(options: SelfHostedRouterConfigAdapterOptions) {
    this.#writer = options.writer;
    this.#kind = options.kind ?? "caddy";
    this.#path = options.path;
    this.#renderer = options.renderer ??
      new router.DefaultRouterConfigRenderer();
    this.#clock = options.clock ?? (() => new Date());
  }

  async apply(
    projection: Parameters<router.RouterConfigPort["apply"]>[0],
  ): Promise<router.RouterConfigApplyResult> {
    const config = this.#renderer.render(projection);
    const content = this.#kind === "caddy"
      ? renderCaddyConfig(config)
      : renderTraefikConfig(config);
    const result = await this.#writer.write({
      kind: this.#kind,
      path: this.#path,
      content,
      config,
    });
    return freezeClone({
      adapter: `selfhosted-${this.#kind}`,
      config,
      appliedAt: this.#clock().toISOString(),
      path: result.path ?? this.#path,
    });
  }
}

export function renderCaddyConfig(config: router.RouterConfig): string {
  const groups = new Map<string, router.RouterConfigRoute[]>();
  for (const route of config.routes) {
    const host = route.host ?? ":80";
    groups.set(host, [...(groups.get(host) ?? []), route]);
  }
  const blocks = [...groups.entries()].map(([host, routes]) => {
    const lines = routes.map((route) => {
      const matcher = route.path ? `handle_path ${route.path}*` : "handle";
      return [
        `  ${matcher} {`,
        `    reverse_proxy ${targetAddress(route)}`,
        "  }",
      ].join("\n");
    });
    return [`${host} {`, ...lines, "}"].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function renderTraefikConfig(config: router.RouterConfig): string {
  const routers = config.routes.map((route) => {
    const rule = [
      route.host ? `Host(\`${route.host}\`)` : undefined,
      route.path ? `PathPrefix(\`${route.path}\`)` : undefined,
    ].filter(Boolean).join(" && ") || "PathPrefix(`/`)";
    return [
      `    ${route.id}:`,
      `      rule: "${rule}"`,
      `      service: ${route.id}`,
      route.protocol === "https" ? "      entryPoints: [websecure]" : undefined,
    ].filter(Boolean).join("\n");
  });
  const services = config.routes.map((route) =>
    [
      `    ${route.id}:`,
      "      loadBalancer:",
      "        servers:",
      `          - url: "http://${targetAddress(route)}"`,
    ].join("\n")
  );
  return [
    "http:",
    "  routers:",
    ...routers,
    "  services:",
    ...services,
    "",
  ].join("\n");
}

function targetAddress(route: router.RouterConfigRoute): string {
  return `${route.target.runtimeRouteId}:${route.target.port ?? 80}`;
}
