/**
 * The ONE step list an install is measured against.
 *
 * An install spans two routes: `/new` registers the source and creates the
 * service, then `/runs/:id?auto=install` runs the deploy. Each route used to
 * own its own step list — 「サービスを準備 / 内容を取得 / サービスを作成 / 変更を確認」
 * on `/new`, then 「コードを取得 / 互換性を確認 / デプロイ / 仕上げ」 on `/runs` —
 * so a single install showed two progress bars, the second restarting near
 * zero with near-synonym labels. One list, one vocabulary, one bar.
 */
import { t } from "../i18n/index.ts";

export type InstallStep = "source" | "create" | "check" | "deploy" | "done";

/** A full install, end to end. `/new` walks source → create → check and hands
 * off mid-list; `/runs` picks the same list up at check and finishes it. */
export const INSTALL_STEPS: readonly InstallStep[] = [
  "source",
  "create",
  "check",
  "deploy",
  "done",
];

/** The last step `/new` can reach, and the first `/runs` can show: the two
 * halves meet here, which is what keeps the bar moving forward across the
 * navigation instead of resetting. */
export const INSTALL_HANDOFF_STEP: InstallStep = "check";

/** A 1-tap update reuses the existing service, so it never runs source/create.
 * It gets the same card off a shorter list rather than opening at 50%. */
export const UPDATE_STEPS: readonly InstallStep[] = ["check", "deploy", "done"];

export function installStepLabel(step: InstallStep): string {
  switch (step) {
    case "source":
      return t("install.step.source");
    case "create":
      return t("install.step.create");
    case "check":
      return t("install.step.check");
    case "deploy":
      return t("install.step.deploy");
    case "done":
      return t("install.step.done");
  }
}

/** Percentage of `step` within `steps`. Never 0 and never a full 100 while
 * still in progress: a just-started install has to read as already moving, and
 * a filled bar that is still waiting reads as stuck. A step outside `steps`
 * reads as the start rather than as a negative width. */
export function installStepPercent(
  step: InstallStep,
  steps: readonly InstallStep[] = INSTALL_STEPS,
): number {
  const index = steps.indexOf(step);
  const position = index < 0 ? 0 : index;
  return Math.min(100, Math.round(((position + 0.5) / steps.length) * 100));
}
