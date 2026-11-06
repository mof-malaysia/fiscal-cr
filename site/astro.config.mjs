// FiscalCR's landing page: a static Astro build of the FTDS Astro components
// (copied from Laman's marketing site), deployed to GitHub Pages by
// .github/workflows/site.yml. One page, English.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// The deploy sets SITE_BASE from Pages' own path (configure-pages' base_path):
// /fiscal-cr today, / once there's a custom domain. Unset, as in `pnpm dev`,
// the site builds for the root.
const base = process.env.SITE_BASE ?? "/";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://mof-malaysia.github.io",
  base,
  output: "static",
  build: { format: "file" },
  trailingSlash: "never",
  vite: { plugins: [tailwindcss()] },
});
