/**
 * The dashboard's ONE install progress surface.
 *
 * An install spans two routes: `/new` registers the source and creates the
 * service, then `/runs/:id?auto=install` runs the deploy. Each route used to
 * draw its own "installing" screen — a bare bar labelled
 * 「サービスを準備 / 内容を取得 / サービスを作成 / 変更を確認」 on `/new`, then a
 * different card labelled 「コードを取得 / 互換性を確認 / デプロイ / 仕上げ」 on
 * `/runs` whose bar restarted near zero at the hand-off. One install read as
 * two or three separate installs.
 *
 * So both routes render THIS card, off ONE step list, with a percentage that
 * only moves forward across the navigation. The step a route cannot reach it
 * simply never passes — it does not restart the list.
 */
import { createSignal, onMount, Show, type JSX } from "solid-js";
import { t } from "../../i18n/index.ts";
import { appMonogram } from "../../lib/app-face.ts";
import {
  INSTALL_STEPS,
  installStepLabel,
  installStepPercent,
  type InstallStep,
} from "../../lib/install-steps.ts";

export {
  INSTALL_STEPS,
  INSTALL_HANDOFF_STEP,
  installStepLabel,
  installStepPercent,
  UPDATE_STEPS,
  type InstallStep,
} from "../../lib/install-steps.ts";

/** Same monogram rule as the launcher and the store grid — an install must not
 * show a different face than the card the visitor just tapped. A nameless
 * install has no monogram at all, so it gets a neutral placeholder. */
function initials(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? appMonogram(trimmed) : "··";
}

/** A polite live region that mounts EMPTY and fills a microtask later — a
 * screen reader only announces text that changes INSIDE an already-mounted
 * region, so a region that mounts together with its text stays silent. */
function AnnouncedLive(props: { readonly text: string }) {
  const [announce, setAnnounce] = createSignal(false);
  onMount(() => queueMicrotask(() => setAnnounce(true)));
  return (
    <p class="sr-only" role="status" aria-live="polite">
      <Show when={announce()}>{props.text}</Show>
    </p>
  );
}

export interface InstallProgressCardProps {
  /** The app being installed. Falls back to the generic 追加中… line while the
   * name is still unknown. */
  readonly name?: string | undefined;
  /** Title to show while `name` is unknown. The icon stays neutral either way —
   * initials of a placeholder sentence would read as an app called 追加中. */
  readonly genericTitle?: string;
  /** Store icon where one is known; initials of `name` otherwise. */
  readonly icon?: JSX.Element;
  readonly step: InstallStep;
  readonly steps?: readonly InstallStep[];
  /** Muted line under the title — a slow-install hint, an activation note. */
  readonly note?: string;
  /** Announce the phase from inside the card. Callers that already own a live
   * region covering every phase (done / error / gate) leave this unset rather
   * than announcing twice. */
  readonly live?: boolean;
  /** Trailing slot: the collapsed step detail on `/new`, the drop-to-console
   * escape hatch on `/runs`. */
  readonly children?: JSX.Element;
}

export function InstallProgressCard(
  props: InstallProgressCardProps,
): JSX.Element {
  const steps = () => props.steps ?? INSTALL_STEPS;
  const percent = () => installStepPercent(props.step, steps());
  const phase = () => installStepLabel(props.step);
  return (
    <div class="av-install">
      <div class="av-install-card av-install-progress">
        <Show when={props.live}>
          <AnnouncedLive text={phase()} />
        </Show>
        <div class="av-install-head">
          <span class="av-install-icon" aria-hidden="true">
            <Show when={props.icon} fallback={initials(props.name)}>
              {props.icon}
            </Show>
          </span>
          <div class="av-install-head-text">
            <h2>
              {props.name ??
                props.genericTitle ??
                t("install.installingGeneric")}
            </h2>
            <p class="muted">{props.note ?? t("install.wait")}</p>
          </div>
        </div>
        <div
          class="av-install-bar"
          role="progressbar"
          aria-label={t("install.progressAria")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent()}
        >
          <i style={{ width: `${percent()}%` }} aria-hidden="true" />
        </div>
        {/* The bar already carries "this is moving". A second spinning
            indicator next to it reads as two overlapping waits, so the phase
            line is plain text. */}
        <p class="av-install-phase">{phase()}</p>
        {props.children}
      </div>
    </div>
  );
}
