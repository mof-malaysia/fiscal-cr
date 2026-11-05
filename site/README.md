# FiscalCR landing page

The public landing page for FiscalCR: a static Astro site on the FTDS Astro components (copied from Laman's marketing site), deployed to GitHub Pages by `.github/workflows/site.yml`.

```sh
cd site
pnpm install
pnpm dev        # http://localhost:4322
pnpm build      # SITE_BASE=/fiscal-cr for the GitHub Pages path
```

- `src/pages/index.astro`: the page and its copy.
- `src/components/home/ReviewField.astro`: the opening's canvas, the Review Field.
- `src/components/home/ExampleReview.astro`: the example review and its "Push the fix" toggle.
- `src/site.ts`: links and the workflow the Copy buttons copy. Keep it in step with the README's quick start.
- `src/components/ui`, `src/lib/ftds`, `styles/ftds.css`: FTDS, as shipped. Update from the FTDS registry rather than editing by hand.
