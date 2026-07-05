import { App } from "./ui/app.js";

// hash do commit publicado (injetado no build via vite `define`; "dev" em build local sem git).
declare const __COMMIT__: string;

// entry-point: instancia o app (wiring dos eventos acontece no construtor).
// Exposto em window.app p/ debugging/automação (inspeção do dial parseado, etc.).
(window as unknown as { app: App }).app = new App();

// badge de build no rodapé.
const build = document.getElementById("build");
if (build) {
  build.textContent = `build ${__COMMIT__}`;
  if (build instanceof HTMLAnchorElement && __COMMIT__ !== "dev") {
    build.href = `https://github.com/joshuapassos/CMF-Watch-Pro-2-BLE-Protocol/commit/${__COMMIT__}`;
  }
}
