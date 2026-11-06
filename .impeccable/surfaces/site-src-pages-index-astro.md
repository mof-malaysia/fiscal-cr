---
version: 1
slug: "site-src-pages-index-astro"
primary_target: "site/src/pages/index.astro"
related_targets: []
---

# FiscalCR landing page

Scope: the public landing page for FiscalCR (`site/`), English, one page with anchors, deployed to GitHub Pages. Mode: Persuade.

Audience: tech leads, staff and platform engineers deciding whether to add AI review to their GitHub repos; the developers who will read its comments. Job: believe the reviews are worth reading, that it runs on their model in their CI, and that setup is one file. Action: copy the workflow (primary, in working form on the page), GitHub repo (secondary). Lead belief (owner): reviews worth reading. Proof: an authored example review (labelled as an example, in FTDS style, never a pixel copy of GitHub's UI), the real workflow YAML and config keys, the real provider/model table, real mechanisms (confidence threshold, dedupe, resolve on fix, base-revision routing, OIDC). Constraints: FTDS tokens and Astro components, Inter, the primary field allowed as on Laman; no invented stars, users, benchmarks or testimonials.

Memorable moment: the Review Field, a moving minimap of a pull request on the primary field; a review pass sweeps it, a few lines light up as findings, then settle to green as they're fixed.

## Direction contract

THESIS: Show the review doing its job before saying anything: the first viewport is a pull request seen as a field of code lines being reviewed, then everything proves "reviews worth reading" with the real mechanism, the real config and the real install. It refuses the category's headline-over-screenshot hero and the feature-card grid.

OWN-WORLD: FTDS on white and Gray 50, Inter, FTDS components. FiscalCR's expression: Primary 700 field with Primary 950 stage; code lines drawn as rounded bars in Primary 300-500, findings marked in Warning 300 and Danger 400, resolution in Success 400. A bracket-and-check mark. Dark code blocks as on Laman.

STORY: Visitors see a PR being reviewed; read that it's AI review from the model they choose in their own CI; see an example review with inline findings that resolve; see how the pipeline works, which models, what they control in YAML, why the key and code stay theirs; copy the workflow.

FIRST VIEWPORT: The Review Field fills it (full height less the navbar). Left-aligned on desktop: H1 in white (up to 88px), one-line lead, Copy workflow (white field button that copies the YAML) and View on GitHub (quiet). A finding card (one real-looking example) floats where the sweep lit a line. Phones: stacked, field behind.

FORM: Abstract data art plus simple text, FTDS family, owner's call 5 Nov 2026 after two direction rounds (Inspection Tags, then a bolder hand led by One-bit Desktop) were set aside for the FTDS family. Signature interaction: the sweep follows the pointer's height and lights the lines it passes. Motion grammar: the sweep moves slowly and continuously while on screen; reduced motion draws one still frame with findings shown; no canvas leaves a CSS field. seed:c275eafa3b5a9228

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
