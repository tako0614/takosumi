// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";

function start() {
  return mount(() => <StartClient />, document.getElementById("app")!);
}

export default start();
