import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import config from "../../app-docs/.vitepress/config.ts";

test("hosted docs keep VitePress component scopes across checkout locations", () => {
  const componentId = config.vue?.features?.componentIdGenerator;
  if (typeof componentId !== "function") throw new Error("Missing hosted docs component ID generator");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
  const component = "node_modules/vitepress/dist/client/theme-default/components/VPLocalSearchBox.vue";
  const source = "<template><div/></template>";

  expect(componentId(`../../shared/docs/${component}`, source, true, hash)).toBe(
    componentId(`../../../../deeper/checkout/docs/${component}`, source, true, hash),
  );
  expect(componentId(component, source, true, hash)).toBe(hash(component + source));
  expect(componentId(component, "<template><main/></template>", true, hash)).not.toBe(
    componentId(component, source, true, hash),
  );
  expect(componentId(component, source, false, hash)).toBe(hash(component));
  const local = ".vitepress/theme/LocalSearchBox.vue";
  expect(componentId(local, source, true, hash)).toBe(hash(local + source));
});
