import { Title } from "@solidjs/meta";
import InkdropMark from "~/components/brand/InkdropMark";
import SignInPanel from "~/components/auth/SignInPanel";

export default function SignIn() {
  return (
    <>
      <Title>サインイン — Takosumi</Title>
      <div class="auth-page">
        <a href="/" class="auth-brand">
          <InkdropMark size={32} />
          <span class="auth-brand-text">Takosumi</span>
        </a>
        <SignInPanel />
      </div>
    </>
  );
}
