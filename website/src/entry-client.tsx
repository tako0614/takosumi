import { hydrate, render } from "solid-js/web";
import App from "./app";

const root = document.getElementById("app")!;

if (root.dataset.prerendered === "true") {
  hydrate(() => <App />, root);
} else {
  render(() => <App />, root);
}
