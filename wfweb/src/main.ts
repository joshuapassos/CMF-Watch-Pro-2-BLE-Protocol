import { App } from "./ui/app.js";

// entry-point: instancia o app (wiring dos eventos acontece no construtor).
// Exposto em window.app p/ debugging/automação (inspeção do dial parseado, etc.).
(window as unknown as { app: App }).app = new App();
