import type { RouteProjection } from "../../domains/routing/mod.ts";
import {
  activationSnapshot,
  DefaultRouterConfigRenderer,
  freezeClone,
  validateProjectionActivationUnchanged,
  validateRouterConfigActivation,
} from "./render.ts";
import type {
  RouterConfigApplyResult,
  RouterConfigPort,
  RouterConfigRenderer,
} from "./types.ts";

export class NoopRouterConfigAdapter implements RouterConfigPort {
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
      return Promise.resolve(freezeClone({
        adapter: "noop",
        config,
        appliedAt: this.#clock().toISOString(),
        noop: true,
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
