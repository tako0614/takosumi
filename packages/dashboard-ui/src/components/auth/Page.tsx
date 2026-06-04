import { Title } from "@solidjs/meta";
import { Show, type JSX } from "solid-js";
import AuthGuard from "~/components/auth/AuthGuard";
import type { SessionRecord } from "~/lib/session";

interface Props {
  /**
   * Document title. The repeated dashboard pattern always appends
   * " — Takosumi", so pass only the page-specific prefix. Omit on routes
   * (e.g. /apps/[id]) that set the title dynamically inside their body.
   */
  title?: string;
  children: (session: SessionRecord) => JSX.Element;
}

/**
 * Shared auth-gated page preamble. Replaces the repeated
 *
 *   <>
 *     <Title>… — Takosumi</Title>
 *     <AuthGuard>{(session) => …}</AuthGuard>
 *   </>
 *
 * chrome that was hand-rolled across the dashboard routes. Behaviour is
 * identical: the title (when given) is rendered, then AuthGuard handles the
 * session probe / spinner / sign-in redirect and only invokes `children`
 * with a live session once authenticated.
 */
export default function Page(props: Props) {
  return (
    <>
      <Show when={props.title}>
        {(t) => <Title>{t()} — Takosumi</Title>}
      </Show>
      <AuthGuard>{(session) => props.children(session)}</AuthGuard>
    </>
  );
}
