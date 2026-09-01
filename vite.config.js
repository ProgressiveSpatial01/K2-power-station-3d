// vite.config.js — added 2026-08-31, pre-deployment: Vite's default
// `vite build` only bundles the root `index.html` as its entry point.
// This app has ALWAYS had two real pages (`index.html` the 2D map,
// `3d.html` the Three.js scene, linked to each other via "3D View →" /
// "← 2D Map") — invisible during `npm run dev` (Vite's dev server serves
// any file by path, built or not), but confirmed for real by actually
// running `npm run build` and finding `3d.html` entirely missing from
// `dist/` — the "3D View" link would have 404'd the moment this was
// deployed anywhere. Multi-page build config fixes it for both pages.

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { defineConfig } from "vite";

// package.json has "type": "module", so this file is loaded as real ESM
// — no __dirname global available (that's a CommonJS-only thing), hence
// deriving it from import.meta.url instead.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        threeD: resolve(__dirname, "3d.html"),
      },
    },
  },
});
