import { defineConfig } from "vite";
import { execSync } from "node:child_process";

// Hash do commit: no CI vem de COMMIT_HASH (github.sha); local cai no `git rev-parse` (ou "dev").
const commit =
  process.env.COMMIT_HASH?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "dev";
    }
  })();

// base:'./' → paths relativos, essencial p/ hospedar em GitHub Pages (sub-path do repo).
export default defineConfig({
  base: "./",
  define: {
    __COMMIT__: JSON.stringify(commit),
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
