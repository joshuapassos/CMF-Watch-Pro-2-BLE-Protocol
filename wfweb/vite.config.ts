import { defineConfig } from "vite";

// base:'./' → paths relativos, essencial p/ hospedar em GitHub Pages (sub-path do repo).
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
