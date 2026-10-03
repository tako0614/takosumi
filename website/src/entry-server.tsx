import { generateHydrationScript, renderToString } from "solid-js/web";
import App from "./app";

export function renderApp() {
  return renderToString(() => <App />);
}

export function renderHydrationBootstrap() {
  return generateHydrationScript();
}
