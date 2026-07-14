import type { OpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";

/**
 * Test-only durable marker around the in-memory implementation.
 *
 * Bootstrap durability tests need to isolate one store family at a time. The
 * proxy binds every method back to the real in-memory instance while presenting
 * a durable composition marker for the unrelated store family under test.
 */
export function declaredDurableTestOpenTofuStore(): OpenTofuControlStore {
  const store = new InMemoryOpenTofuControlStore();
  return new Proxy(store, {
    get(target, property) {
      if (property === "persistence") return "durable";
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
