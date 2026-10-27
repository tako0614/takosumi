/**
 * `/workloads` — the old list of every installed app. Home now shows every
 * installed app with its state (TASK-0115), so this route only forwards there.
 * The route itself is owned by the shell's router and can be dropped with
 * this file once it redirects on its own.
 */
import { Navigate } from "@solidjs/router";

export default function WorkloadListView() {
  return <Navigate href="/" />;
}
