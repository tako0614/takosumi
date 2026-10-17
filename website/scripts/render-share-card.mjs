/**
 * Render the 1200 × 630 share card for takosumi.com and its docs from the
 * landing's own pieces: the real mark, the hero line, and the actual dashboard
 * Home capture (see capture-product-ui-provenance.md). Run it after the Home
 * capture or the hero line changes:
 *
 *   FONTCONFIG_FILE=… node website/scripts/render-share-card.mjs
 *
 * Japanese text uses the system sans (Noto Sans JP through the fontconfig file
 * the dashboard captures use).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const website = resolve(here, "..");
const outputs = [
  resolve(website, "public/brand/og-cover.png"),
  resolve(website, "../docs/public/og-cover.png"),
];

const dataUri = async (path, type) => `data:${type};base64,${(await readFile(path)).toString("base64")}`;
const mark = await dataUri(resolve(website, "public/tako.png"), "image/png");
const home = await dataUri(resolve(website, "public/screens/dashboard-home-desktop.png"), "image/png");
const font = await dataUri(
  resolve(website, "node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2"),
  "font/woff2",
);

// The hero line from website/src/routes/index.tsx and the dashboard's dark tokens.
const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
@font-face { font-family: "Bricolage Grotesque Variable"; src: url(${font}) format("woff2"); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body { background: #0a0a0b; color: #f5f5f6; font-family: "Bricolage Grotesque Variable", "Noto Sans JP", sans-serif; }
.identity { position: absolute; left: 64px; top: 52px; display: flex; align-items: center; gap: 16px; }
.identity img { width: 56px; height: 56px; border-radius: 13px; }
.identity span { font-size: 52px; font-weight: 560; letter-spacing: -.05em; line-height: 1; }
.lead { position: absolute; left: 64px; top: 138px; font-size: 36px; font-weight: 600; letter-spacing: -.02em; }
.shot { position: absolute; left: 64px; top: 222px; width: 1072px; height: 460px; overflow: hidden; border: 1px solid #37373d; border-radius: 16px; background: #151517; }
.shot img { display: block; width: 100%; height: auto; }
</style></head><body>
<div class="identity"><img src="${mark}" alt=""><span>Takosumi</span></div>
<p class="lead">公開されたオープンソースを、アプリのように入れて使う。</p>
<div class="shot"><img src="${home}" alt=""></div>
</body></html>`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const fit = await page.evaluate(() => {
    const lead = document.querySelector(".lead").getBoundingClientRect();
    return { leadRight: lead.right, families: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family) };
  });
  if (fit.leadRight > 1136) throw new Error(`hero line overflows the card: right edge ${fit.leadRight}`);
  if (!fit.families.includes("Bricolage Grotesque Variable")) throw new Error("Bricolage Grotesque did not load");
  const png = await page.screenshot({ type: "png" });
  for (const output of outputs) {
    await writeFile(output, png);
    console.log(`share card: ${output}`);
  }
} finally {
  await browser.close();
}
