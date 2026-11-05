// FiscalCR's landing page: a static Astro build of the FTDS Astro components
// (copied from Laman's marketing site), deployed to GitHub Pages by
// .github/workflows/site.yml. One page, English.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// GitHub Pages serves the project at /fiscal-cr until there's a custom domain.
// SITE_BASE="/" builds for the root (a custom domain, or `pnpm dev`).
const base = process.env.SITE_BASE ?? "/";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://mof-malaysia.github.io",
  base,
  output: "static",
  build: { format: "file" },
  trailingSlash: "never",
  vite: { plugins: [tailwindcss()] },
});
