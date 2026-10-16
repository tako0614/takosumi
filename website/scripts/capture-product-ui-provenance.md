# Website application captures

These are actual product interfaces rendered with public demo data, captured or
reused on 2026-09-28. They illustrate application use. They do not prove a live
Takosumi installation, successful deployment, actual agent execution or measured
performance. The website labels them as demo screens.

| Product | Source | Method |
| --- | --- | --- |
| Takos | `1da7a7d0e5e3d6a0c552cd29976c0fc9abe9105b` | Its website capture script renders the actual web UI in light and dark appearances with seeded conversation/tool data. Desktop is a panel crop; mobile is a separate viewport. See that repository's capture provenance. |
| Yurucommu | `2eafd70e60176d2506c54e04d325411c38c09a77` | Unmodified repo-owned `site/assets/shots/yurucommu-home.webp` and `yurucommu-mobile.webp`. Their `.mock.yurucommu.test` accounts are demo data. |
| Takos Office | Working tree based on `9ac38fdd75653fdb2a85bdf9ae1aedb4bdad4c25`, including its pre-existing uncommitted Docs/shared UI changes | `capture-office-ui.mjs` runs the actual Docs editor SPA in light and dark appearances. It intercepts document and identity GETs with a sample document and blocks API writes. |

The Takos chat captures use the actual product's light and dark themes. The
capture script supplies illustrative conversation data without changing the
Takos interface source. The website picks matching Takos and Office images for
the operating system appearance; Yurucommu uses the same native screenshots
in both appearances.

No application chrome is redrawn and no screenshot pixels are edited. Office
shows the development checkout's interface, not a claim that every visual detail
matches the pinned install release. That checkout was read without modifying or
committing its existing work. Yurucommu assets were clean; their last source
commit was `bbc683fbb257e9a60844cf40d89ed95aed1b30ac`.

Office
desktop uses a 1000 × 680 viewport, mobile 390 × 620, both at device scale 2.
`website/src/content/captures.ts` records every file's exact dimensions. Takos
and Office light images keep the unsuffixed filenames; their dark images use
`-dark` before the viewport suffix.

After installing dependencies in Takosumi, Takos and Takos Office, run from this
repository:

```sh
node website/scripts/capture-product-ui.mjs
```

This requires system Chrome, Takosumi's installed `@playwright/test`, and free
ports 5197 and 5198. The script captures Takos, copies its chat images and the
repo-owned Yurucommu images, then captures Office. Default source repositories
are siblings. Set `TAKOS_ROOT`, `YURUCOMMU_ROOT`, and `TAKOS_OFFICE_ROOT` to
absolute checkout paths when using separate worktrees. Takos also accepts
`PLAYWRIGHT_MODULE` for a nonstandard Playwright installation.

To update Office alone, use `node website/scripts/capture-office-ui.mjs`.
Update the dimension manifest whenever a viewport or panel crop changes, and
verify all three selections on the final website at desktop and mobile widths.

## Takosumi dashboard

The twelve `dashboard-home-*`, `dashboard-install-*` and `dashboard-review-*`
images capture this checkout's actual `dashboard` SPA,
built from source and served by the
repository's portable browser fixture server. The Home and Store images were
first captured on 2026-09-28; the review images are described below. The original dark images came from checkout
`d4b1c52f8434cb163ac76f1a4682baf564612acc`; the matching light images
came from checkout `3820a6359e7e044d5283b662540f80212b3929d9`.
The dark and light desktop Home images were refreshed on 2026-10-04 from
checkout `0f9f6ac2e` with a full 1200 × 750 viewport. The four Store images were
recaptured on 2026-10-15 from the dashboard source at `46d87d185`, because the
earlier ones showed a 「Source」 tab and heading copy that the dashboard no
longer has. Recapturing Home from the same source produced byte-identical
images, so the Home files are unchanged.
`capture-dashboard-ui.mjs` intercepts the public example session, Workspace,
Capsule, and authorized `interface.ui.surface` list reads for the Home launcher,
plus the TCS v2 Store discovery reads. The three products are illustrative:
Takos, Takos Office, and Yurucommu, with `example.test` launch URLs and
`github.com/example` source URLs. Their rows are shaped as the dashboard's
real API projections; they do not describe installed production services or
available official Store listings. The Store images show the Store with
three listings before one is chosen, not completed configuration or
installation; the landing no longer shows them, but the script still keeps them
current. Outside the add-flow screens below, all non-GET requests and external
browser requests are blocked. The
Takos icon is the current `website/public/apps/takos.png`; Office and
Yurucommu use this repository's `dashboard/public/brand/` SVGs. All three
are fulfilled locally at an illustrative icon origin.
Browser runtime errors, failed HTTP requests or images, unexpected external
requests, and missing product cards fail the capture.

The four `dashboard-review-*` images, captured on 2026-10-15 from the dashboard
source at `d128a386f` (after #493 fixed the 「ホスト / アカウント」 row) and
recaptured on 2026-10-16 from `9f6218bfd` (after #496 changed the review's badge
from 「成功」 to 「確認できます」), show the
add flow's 「追加前の確認」 screen for Takos, reached by opening `/new` with an
example Git URL and pressing 「追加」 in the real dashboard. For this screen and
the Quickstart screens, the script answers the add flow's API calls in the
browser, following the shapes used by the dashboard's
portable e2e fixture: source registration and sync, the resolved snapshot and
its module, a compatibility report that requires the Cloudflare provider, one
verified workspace connection for it, the default install config, the install
plan, and its plan Run. Everything is an illustrative example (the
`github.com/example/takos` URL, a placeholder commit, IDs, the connection); no
request reaches a live API or a Git host, and the screen proves no plan,
approval, or apply. The one value derived from a real source is the change
count: takos v0.12.7 `deploy/opentofu/cloudflare` creates 1 D1 database, 1 KV
namespace, 5 R2 buckets and 6 queues on a fresh install, so the Run reports 13
to create, 0 to change and 0 to delete, with policy passing and no approval
required. The real Takos module also asks for settings on 「サービスを設定」
(a required 「Cloudflare デプロイ設定」 and optional public URL and Takosumi
Accounts inputs in its v0.12.7 manifest) before this review; the
stub uses the default install config, so that step is skipped and the image
shows only the review. The 13 covers the module's own resources; the Vectorize
index and Worker upload that Takos performs in its own follow-up step are not
part of this plan. The capture fails unless the screen shows those three counts
and its 「追加する」 button.

Desktop Home, Store and review use the complete 1200 × 750 viewport, with no
screenshot clip. Mobile Home uses 390 × 700, and
mobile Store and review use 390 × 950 so the first service card, or the change
counts and 「追加する」, are readable.
All use device scale 2, Japanese locale, loaded UI fonts, and Noto Sans JP as the system
Japanese fallback. The script seeds the dashboard's own `tg_theme` preference
to match the browser color scheme and confirms the rendered `data-theme` before
saving each dark or light image. `DASHBOARD_CAPTURES` records the resulting exact pixel
dimensions. No HTML or screenshot pixels were redrawn or edited.

After installing the Takosumi repository dependencies, rebuild the dashboard
and capture from this repository:

```sh
cd dashboard && bun run build && cd ..
FONTCONFIG_FILE=/root/.cache/task-0052-fonts/fonts.conf node website/scripts/capture-dashboard-ui.mjs all
```

The fontconfig path above is a task-local example. Any setup with Noto Sans JP
available as a Japanese sans fallback works. The script requires system Chrome,
Takosumi's installed `@playwright/test`, and free port 5199. The fixture server
does not write to a live Takosumi API. These are UI illustrations, not deploy,
Run, or end-to-end proof.
Pass `light` or `dark` instead of `all` to refresh one appearance only. Pass
`desktop-home` as the second argument to refresh only the desktop Home images
without rewriting the Store, review or mobile assets. Dark
images keep their original filenames; light images use a `-light` suffix. The
site's `<picture>` sources follow the operating system appearance and viewport.

## Quickstart screens in the docs

The twelve `docs/public/getting-started/quickstart-*.png` images, captured on
2026-10-15 from the dashboard source at `d128a386f` (the four `quickstart-review*`
images recaptured on 2026-10-16 from `9f6218bfd`, after #496), show the three screens
that Quickstart step 6 describes, in Japanese and English and in
light and dark (`-en` and `-dark` suffixes). The same script opens the
Quickstart's own link,
`/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic`,
in the real dashboard and presses 「追加」 and 「続ける」 (Add, Continue) as a
reader would. It answers that flow's API calls in the browser like the review
screen above, and no request reaches a live API or a Git host.

What the screens show is derived from this repository rather than invented:

- The two optional inputs, 名前 and 公開URLの例 (Name, Example public URL), are
  the `variablePresentation` that `compileRepositoryInstallUx` produces from
  `.well-known/takosumi.json` for `examples/opentofu-basic`.
- The review's 0 / 0 / 0 is what `tofu plan` (OpenTofu 1.12.3) reports for
  `examples/opentofu-basic/main.tf`: no resource changes, only two outputs.
- The service name `takosumi` is the dashboard's own default for that Git URL.

The resolved commit, IDs and the 「デモ環境」 / "Demo workspace" name are
placeholders; none of them appears in the images. The first image is the whole add page without the dashboard
shell; the other two are clipped to the part of the card each step adds. The
capture fails unless each heading appears and the review shows 0, 0 and 0 with
its 「追加する」 (Add) button.

The default run (`all`) rewrites these together with the website images. To
refresh only these, run the script with `all quickstart` (or `light
quickstart` / `dark quickstart`). If the image sizes change, update the
`width` and `height` attributes in both Quickstart pages to match.
