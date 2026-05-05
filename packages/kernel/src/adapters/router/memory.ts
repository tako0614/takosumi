import type { RouteProjection } from "../../domains/routing/mod.ts";
import {
  activationSnapshot,
  DefaultRouterConfigRenderer,
  freezeClone,
  validateProjectionActivationUnchanged,
  validateRouterConfigActivation,
} from "./render.ts";
import type {
  RouterConfig,
  RouterConfigApplyResult,
  RouterConfigPort,
  RouterConfigRenderer,
} from "./types.ts";

export class InMemoryRouterConfigAdapter implements RouterConfigPort {
  readonly #configs = new Map<string, RouterConfig>();
  readonly #renderer: RouterConfigRenderer;
  readonly #clock: () => Date;

  constructor(options: {
    readonly renderer?: RouterConfigRenderer;
    readonly clock?: () => Date;
  } = {}) {
    this.#renderer = options.renderer ?? new DefaultRouterConfigRenderer();
    this.#clock = options.clock ?? (() => new Date());
  }

  apply(projection: RouteProjection): Promise<RouterConfigApplyResult> {
    try {
      const before = activationSnapshot(projection);
      const config = this.#renderer.render(projection);
      validateRouterConfigActivation(projection, config);
      validateProjectionActivationUnchanged(before, projection);
      const stored = freezeClone(config);
      this.#configs.set(stored.id, stored);
      return Promise.resolve(freezeClone({
        adapter: "memory",
        config: stored,
        appliedAt: this.#clock().toISOString(),
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  get(id: string): Promise<RouterConfig | undefined> {
    const config = this.#configs.get(id);
    return Promise.resolve(config && freezeClone(config));
  }

  list(): Promise<readonly RouterConfig[]> {
    return Promise.resolve(
      [...this.#configs.values()].map((config) => freezeClone(config)),
    );
  }

  clear(): Promise<void> {
    this.#configs.clear();
    return Promise.resolve();
  }
}
