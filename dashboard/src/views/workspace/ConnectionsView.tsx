/** Legacy connection route: personal connections live under Account. */
import { Navigate, useLocation } from "@solidjs/router";

export default function ConnectionsView() {
  const location = useLocation();
  return <Navigate href={`/account/connections${location.search}`} />;
}
