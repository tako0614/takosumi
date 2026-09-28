import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const takosRoot = resolve(process.env.TAKOS_ROOT || resolve(root, "../takos"));
const yurucommuRoot = resolve(process.env.YURUCOMMU_ROOT || resolve(root, "../yurucommu"));
const screens = resolve(here, "../public/screens");

function run(script, cwd) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${script} failed: ${result.status}`);
}

await mkdir(screens, { recursive: true });
run(resolve(takosRoot, "website/scripts/capture-product-ui.mjs"), takosRoot);
const themes = process.env.CAPTURE_THEME ? [process.env.CAPTURE_THEME] : ["light", "dark"];
for (const theme of themes) for (const variant of ["desktop", "mobile"]) {
  await copyFile(
    resolve(takosRoot, `website/public/screens/chat-${theme}-${variant}.png`),
    resolve(screens, `takos-app-${theme === "dark" ? "dark-" : ""}${variant}.png`),
  );
}
await copyFile(
  resolve(yurucommuRoot, "site/assets/shots/yurucommu-home.webp"),
  resolve(screens, "yurucommu-desktop.webp"),
);
await copyFile(
  resolve(yurucommuRoot, "site/assets/shots/yurucommu-mobile.webp"),
  resolve(screens, "yurucommu-mobile.webp"),
);
run(resolve(here, "capture-office-ui.mjs"), root);
console.log("Takos, Yurucommu, and Takos Office UI assets copied/captured.");
