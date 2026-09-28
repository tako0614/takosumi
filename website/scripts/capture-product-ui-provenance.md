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

The eight `dashboard-home-*` and `dashboard-install-*` images capture this checkout's actual `dashboard` SPA,
built from source and served by the
repository's portable browser fixture server. They were captured on
2026-09-28. The original dark images came from checkout
`d4b1c52f8434cb163ac76f1a4682baf564612acc`; the matching light images
came from checkout `3820a6359e7e044d5283b662540f80212b3929d9`.
`capture-dashboard-ui.mjs` intercepts the public example session, Workspace,
Capsule, and authorized `interface.ui.surface` list reads for the Home launcher,
plus the TCS v2 Store discovery reads. The three products are illustrative:
Takos, Takos Office, and Yurucommu, with `example.test` launch URLs and
`github.com/example` source URLs. Their rows are shaped as the dashboard's
real API projections; they do not describe installed production services or
available official Store listings. The Store images show source selection,
not completed configuration or installation. All non-GET requests and external browser requests are blocked. The
Takos icon is the current `website/public/apps/takos.png`; Office and
Yurucommu use this repository's `dashboard/public/brand/` SVGs. All three
are fulfilled locally at an illustrative icon origin.
Browser runtime errors, failed HTTP requests or images, unexpected external
requests, and missing product cards fail the capture.

The desktop Home capture is a direct 1200 × 440 viewport clip; desktop Store
uses a 1200 × 750 viewport. Mobile Home uses 390 × 700, and
mobile Store uses 390 × 950 so the first service card is readable.
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
Pass `light` or `dark` instead of `all` to refresh one appearance only. Dark
images keep their original filenames; light images use a `-light` suffix. The
site's `<picture>` sources follow the operating system appearance and viewport.
