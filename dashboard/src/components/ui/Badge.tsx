import type { JSX } from "solid-js";

export type Tone = "ok" | "warn" | "danger" | "info" | "muted" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  ok: "tg-badge-ok",
  warn: "tg-badge-warn",
  danger: "tg-badge-danger",
  info: "tg-badge-info",
  muted: "tg-badge-muted",
  neutral: "",
};

interface Props {
  tone?: Tone;
  class?: string;
  children: JSX.Element;
}

/** Token-driven pill. One badge for all status / tag / policy chips. */
export function Badge(props: Props): JSX.Element {
  return (
    <span class={`tg-badge ${TONE_CLASS[props.tone ?? "neutral"]} ${props.class ?? ""}`}>
      {props.children}
    </span>
  );
}

/**
 * StatusBadge — a Badge whose tone is derived from a status string via a
 * caller-supplied label fn (from lib/status-labels.ts) and a tone mapping.
 * Replaces the StatusPill / AppStatusPill / .policy-* / .graph-node-status-*
 * scatter with one token-driven component.
 */
export function StatusBadge(props: {
  status: string | undefined;
  /** Maps the raw status to its user-facing label. */
  label: (s: string | undefined) => string;
  /** Maps the raw status to a tone. */
  tone: (s: string | undefined) => Tone;
  class?: string;
}): JSX.Element {
  return (
    <Badge tone={props.tone(props.status)} class={props.class}>
      {props.label(props.status)}
    </Badge>
  );
}
