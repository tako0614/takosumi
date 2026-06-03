import { Title } from "@solidjs/meta";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";

export default function Home() {
  return (
    <>
      <Title>Home — Takosumi</Title>
      <AuthGuard>
        {(session) => (
          <AppShell>
            <div class="page-header">
              <h1>Welcome back.</h1>
              <p class="page-sub">
                <Display
                  name={session.displayName}
                  sub={session.subject}
                  email={session.email}
                />
              </p>
            </div>
            <section class="empty-state">
              <p>まだ何も installed されていません。</p>
              <a href="/install" class="btn btn-primary">
                最初のアプリを install →
              </a>
            </section>
          </AppShell>
        )}
      </AuthGuard>
    </>
  );
}

function Display(props: { name?: string; sub: string; email?: string }) {
  if (props.name) return <>Signed in as {props.name} ({props.sub})</>;
  if (props.email) return <>Signed in as {props.email} ({props.sub})</>;
  return <>Signed in as {props.sub}</>;
}
