---
name: FiscalCR
description: FTDS, with FiscalCR's own expression, for the landing page of an open-source AI code reviewer for GitHub pull requests.
colors:
  ftds-blue: "#2563EB"
  ftds-blue-wash: "#EFF6FF"
  focus-blue: "#3A75F6"
  field: "#1D4ED8"
  field-veil: "#1E40AF"
  stage: "#172554"
  on-field-text: "#DBEAFE"
  on-field-edge: "#96B7FF"
  selection: "#C2D5FF"
  sheet: "#FFFFFF"
  paper: "#FAFAFA"
  well: "#F4F4F5"
  hairline: "#E4E4E7"
  ink: "#18181B"
  ink-secondary: "#3F3F46"
  ink-tertiary: "#6B6B74"
  code-comment: "#A1A1AA"
  code-string: "#83DAA3"
  danger: "#B91C1C"
  danger-fill: "#DC2626"
  danger-wash: "#FEF2F2"
  danger-edge: "#FCA5A5"
  success: "#15803D"
  success-fill: "#16A34A"
  success-wash: "#F0FDF4"
  success-edge: "#83DAA3"
  warning: "#A16207"
  warning-fill: "#EAB308"
  warning-edge: "#FDE047"
  field-critical: "#F87171"
  field-fixed: "#4ADE80"
typography:
  hero-display:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3rem, 1.4rem + 5vw, 5.5rem)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  hero-lead:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 1rem + 0.4vw, 1.375rem)"
    fontWeight: 400
    lineHeight: 1.375
  section-heading:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-0.02em"
  section-heading-phone:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.27
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
  title:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  lead:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.44
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  caption:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  label-large:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  label-button:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
  code:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  xs: "4px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
  full: "9999px"
spacing:
  gutter-phone: "18px"
  gutter: "24px"
  column-max: "1280px"
  section-phone: "64px"
  section: "96px"
  close-band: "80px"
  split-gap: "48px"
  split-gap-wide: "56px"
  card-pad-phone: "20px"
  card-pad: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ftds-blue}"
    textColor: "{colors.sheet}"
    typography: "{typography.label-button}"
    rounded: "{rounded.md}"
    height: "48px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "{colors.field}"
  button-secondary:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.label-button}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 16px"
  button-field-solid:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ftds-blue}"
    typography: "{typography.label-large}"
    rounded: "{rounded.md}"
    height: "56px"
    padding: "0 24px"
  button-field-solid-hover:
    backgroundColor: "{colors.ftds-blue-wash}"
  button-field-quiet:
    backgroundColor: "rgb(255 255 255 / 0.12)"
    textColor: "{colors.sheet}"
    typography: "{typography.label-large}"
    rounded: "{rounded.md}"
    height: "56px"
    padding: "0 24px"
  button-field-quiet-hover:
    backgroundColor: "rgb(255 255 255 / 0.2)"
  button-code-copy:
    backgroundColor: "rgb(255 255 255 / 0.1)"
    textColor: "{colors.sheet}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  field-band:
    backgroundColor: "{colors.field}"
    textColor: "{colors.sheet}"
  field-chip:
    backgroundColor: "rgb(255 255 255 / 0.12)"
    textColor: "{colors.sheet}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "6px 14px"
  stage-panel:
    backgroundColor: "{colors.stage}"
    rounded: "{rounded.2xl}"
    padding: "20px"
  stage-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
  content-card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "24px"
  quiet-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "24px"
  severity-tag-critical:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  finding-thread:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  diff-line-added:
    backgroundColor: "{colors.success-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
  diff-line-removed:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
  step-number:
    backgroundColor: "{colors.ftds-blue}"
    textColor: "{colors.sheet}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    size: "36px"
  code-block:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    typography: "{typography.code}"
    rounded: "{rounded.xl}"
    padding: "24px"
---

# Design System: FiscalCR

## Overview

**Creative North Star: "The Lit Line"**

FiscalCR's site is a member of the FTDS family: FTDS tokens, FTDS's Astro components (navbar, buttons, footer, icons), and Inter, self-hosted. It does not have its own palette, typeface or radius scale. Its expression comes from a few FTDS primitives promoted to named roles: the Field (Primary 700) as the full-bleed blue it opens and closes on, the Stage (Primary 950) as the dark panel that white objects sit on, and Ink-black code blocks. The one thing it owns outright is the Review Field: a canvas minimap of a pull request where a review pass sweeps down and individual lines light up as findings, turn green as they're fixed, and settle back.

The North Star is that single lit line. Everything on the page is quiet, flat FTDS so that a finding (a danger-red line, a severity tag, a thread with a coloured edge) is the brightest thing in view. Severity colour is reserved for findings and their states; it is never decoration. Density is FTDS's comfortable setting: 48px controls, generous section padding, a 1280px column.

The mark is a bracket and a check in white on an FTDS Blue rounded square (`site/public/logo.svg`): code, then a review that passed. It is the only place the two ideas are drawn as a symbol.

**Key Characteristics:**
- FTDS light theme, comfortable density, Inter throughout, a system monospace for code.
- The Field (Primary 700) opens and closes the page; white, Paper and Sheet carry everything between.
- The Stage (Primary 950) is a contained panel, never a band, holding a white sheet.
- Severity colours (danger, warning, success) appear only as findings, diff lines and check states.
- Flat at rest; the only shadow on the page lifts the hero's example finding off the Field.
- Code is shown dark (Ink background, white text), not in FTDS's inline wash.

## Colors

FTDS Blue on white, with the blue deepened into two surfaces and the three FTDS status hues kept for review findings.

### Primary
- **FTDS Blue** (ftds-blue): text links, MoreLink arrows, the filled primary button, numbered step badges, config keys in the reference list, the Check icon, and the logo square.
- **FTDS Blue Wash** (ftds-blue-wash): hover fill of the white field button.
- **Focus Blue** (focus-blue): the 2px focus ring on white surfaces.

### Secondary: the Field and the Stage
- **The Field** (field): the opening Review Field and the "Your model" and closing bands. Also the primary button's hover and the browser `theme-color`.
- **Field Veil** (field-veil): Primary 800 laid over the Review Field canvas as a gradient (92% to 0% left to right on desktop, a vertical 20/55/30% wash below 64rem) so the headline reads on any part of the canvas.
- **The Stage** (stage): the rounded panel on the Field that holds the release-pinned models table; also the tint of the hero card's shadow.
- **On-Field Text** (on-field-text): secondary text on the Field (leads, item descriptions).
- **On-Field Edge** (on-field-edge): dividers on the Field; also config keys in code blocks and the Review Field's plain code lines.
- **Selection Blue** (selection): text selection on white; the Review Field's changed lines.

### Tertiary: findings
- **Danger** (danger), **Danger Fill** (danger-fill), **Danger Wash** (danger-wash), **Danger Edge** (danger-edge): critical findings. Text, the severity dot, removed diff lines and the severity tag fill, the outline of a critical thread.
- **Warning** (warning), **Warning Fill** (warning-fill), **Warning Edge** (warning-edge): warning findings, by the same pattern.
- **Success** (success), **Success Fill** (success-fill), **Success Wash** (success-wash), **Success Edge** (success-edge): a passing check, added lines, a resolved thread; Success Edge is also string colour in code blocks.
- **Field Critical** (field-critical) and **Field Fixed** (field-fixed): the lighter Danger 400 and Success 400 that findings take on the Review Field canvas, where the -700 text tones would not show on blue. Warning uses Warning Edge there.

### Neutral
- **Sheet** (sheet): page background, cards, the example review, the sheet on the Stage.
- **Paper** (paper): alternating sections (pipeline, details), the summary comment in the example, the App callout.
- **Well** (well): the navbar's secondary button; also FTDS's Divider tone, used for every hairline rule between rows and cards.
- **Hairline** (hairline): the navbar's bottom border.
- **Ink** (ink): body text, and the code block background.
- **Ink Secondary** (ink-secondary): descriptions and supporting copy.
- **Ink Tertiary** (ink-tertiary): file paths, line numbers, small notes, field labels.
- **Code Comment** (code-comment): comments in code blocks.

### Named Rules
**The Severity Is Data Rule.** Danger, warning and success colours appear only where they mean a finding, a diff line or a check state. A decorative red or green on this site is a false finding.

**The Two Blues Rule.** The Field is a full-bleed band; the Stage is a contained, rounded panel on the Field. The Stage never runs edge to edge and never sits on white.

## Typography

**Display Font:** Inter Variable (with Inter, ui-sans-serif, system-ui)
**Body Font:** Inter Variable, the same family
**Label/Mono Font:** ui-monospace (with SF Mono, SFMono-Regular, Menlo, Consolas)

**Character:** One sans at three weights does all the work; hierarchy comes from size and tight negative tracking on headings, not from a second face. Monospace marks anything a developer would type or read in a diff: file paths, config keys, model ids, commands.

### Hierarchy
- **Hero Display** (hero-display): the one h1, set to at most 12ch and balanced. Nowhere else.
- **Hero Lead** (hero-lead): the sentence under the h1, max 34rem.
- **Section Heading** (section-heading, section-heading-phone below 768px): every h2, balanced.
- **Headline** (headline): the three install steps.
- **Title** (title): item titles in lists and cards (FTDS heading-2xs).
- **Lead** (lead): the paragraph under each h2, max about 46rem.
- **Body** (body): list descriptions, step text; detail items capped at 48ch.
- **Body Small** (body-small): table cells, small descriptions on the Field, the hero footnote.
- **Caption** (caption): diff lines, file path captions, the "Example review" note.
- **Label Large** (label-large): field button labels and MoreLinks, weight 500.
- **Label Button** (label-button): FTDS button labels (navbar, "Push the fix"), weight 500.
- **Label** (label): table headers, chips, severity tags, step numbers, weight 600 for tags and headers.
- **Code** (code): code blocks; model ids in the table at 0.8125rem; inline code at 0.9em of its line.

### Named Rules
**The One Display Rule.** The clamp-sized, -0.035em display is the hero's alone. Every other heading uses FTDS's fixed heading scale.

## Layout

A single 1280px column centred with an 18px gutter on phones and 24px from 768px. Sections stack full-bleed and alternate surfaces in a fixed order: the Field (opening), Sheet, the Field, Paper, Sheet, Paper, Sheet, the Field (close). Each section pads 64px top and bottom on phones and 96px from 768px; the closing band uses 80px.

From 1024px, sections with a demonstration use a 12-column grid split 5/7: words left, the object right (the example review, the Stage, the config block, the workflow file), with a 48px gap (56px at the split). Below 1024px they stack, words first. Lists of points run as 2 or 4 columns on the Field and 2 columns on Paper, each item opened by a top hairline.

The opening fills the viewport less the navbar (`100svh - 4rem`). The navbar is FTDS's sticky 64px bar (56px on phones) and collapses to its popover menu below 1280px; the navbar's GitHub and Install buttons hide below 640px. The models table becomes a definition list below 640px.

## Elevation & Depth

Flat. Surfaces separate by tone (Sheet, Paper, the Field, the Stage) and by 1px hairlines, never by shadow. The single shadow on the page is under the hero's example finding card, tinted with the Stage so it reads as depth on blue rather than grey smudge; it exists only because that card floats over a moving canvas. FTDS's card, menu and dialog shadows remain available for FTDS floating layers (the navbar's mobile menu over its scrim).

### Shadow Vocabulary
- **Field lift** (`0 24px 48px -16px rgb(23 37 84 / 0.55)`): a white object floating on the Field. Used once, on the hero finding.

### Named Rules
**The Flat Sheet Rule.** On white and Paper, nothing casts a shadow. A card is a Sheet with a hairline border on Paper, or a Paper panel on Sheet.

## Shapes

Gently rounded, never pill-shaped except for things that are labels. Buttons and finding threads use 8px; content cards, the example review, code blocks and the sheet on the Stage use 14px; the Stage itself 16px, so it nests one step larger than its sheet. Chips, severity tags, step numbers and status dots are full circles or pills. Links get a 4px radius only so their focus ring has corners.

The Review Field's marks share this language at small scale: every code line is a 4px bar with fully rounded ends, highlights are 3px-rounded strips, gutter markers are 4px dots.

## Components

### Buttons
Tonal and steady, FTDS's own.
- **Shape:** gently rounded (rounded.md).
- **Primary:** FTDS Blue fill, white label; 48px (medium) in the example review, 44px (FTDS small, 16px padding) in the navbar; Field on hover.
- **Secondary:** FTDS's tonal Well button (navbar GitHub, 44px), no border.
- **Focus:** a solid 2px ring offset 2px, Focus Blue on white and white on the Field (`.on-field` sets it).
- **Press:** FTDS's half-pixel press-down.

### Field Buttons
On the Field, FTDS's filled primary would disappear, so two field buttons replace it.
- **Solid:** white with FTDS Blue text, 56px tall, FTDS Blue Wash on hover. Used for "Copy workflow".
- **Quiet:** translucent white (12%, 20% on hover) with white text. Used for the secondary link beside it.
- **Copy behaviour:** the copy button swaps its icon to a check and its label to "Copied" for 2.2s, announces through a status region, and on clipboard failure scrolls to the workflow file and says so.

### Code Copy Button
A 32px translucent white button pinned top-right in a code block; the block adds top padding below 768px so it never covers code.

### Links (MoreLink)
FTDS Blue (white on the Field), label weight, a 1px underline offset 3px that thickens to 2px on hover, with a trailing arrow icon.

### Chips
Provider names on the Field: translucent white pills, label size, no border.

### Cards / Containers
- **Corner Style:** rounded.xl.
- **Background:** Sheet with a Well hairline on Paper sections; Paper with no border on Sheet sections.
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 20px on phones, 24px from 768px.

### Code Block
Ink background, white text, body-small monospace at a relaxed 1.625 line height, 14px corners, tab size 2, horizontal scroll rather than wrap. Comments in Code Comment grey, keys in On-Field Edge blue, strings in Success Edge green.

### Navigation
FTDS's navbar: sticky white bar with a Hairline bottom border, logo and "FiscalCR" at body-lg semibold, anchor links, then GitHub (secondary) and Install (primary). Below 1280px the links move into a popover panel over a 40% Ink scrim.

### Numbered Steps
FTDS Blue circles with white semibold numerals (28px in the pipeline, 36px in install), marked `aria-hidden` with the number repeated for screen readers.

### Review Field (signature component)
The opening. A Canvas 2D minimap of a pull request on the Field: files as 210px columns 34px apart, each line a rounded bar on an 11px pitch, changed hunks brighter (Selection Blue at 42% against On-Field Edge at 20%). Columns scroll upward at slightly different slow speeds so it never reads as a grid. A fine horizontal sweep line in On-Field Text moves down the field (or eases toward the pointer's height) with a faint wash above it; lines it passes brighten. Findings on changed lines light up when the sweep crosses them (Field Critical, Warning Edge or On-Field Text by severity) with a highlight strip and gutter dot, hold for 5.2s, turn Field Fixed green for 2.4s, then fade back over 1.6s. One critical line is held beside the hero's example finding card with a hairline lead into it. The canvas fades in over 1.2s, pauses off screen, draws one still frame with findings shown under reduced motion, and without canvas the section is plain Field.

### Example Finding Card
The white card on the Review Field at 1024px and up: a critical severity tag, file path and line, the finding in body semibold, a two-line removed/added diff, and a hairline footer with the confidence. It rises 14px into place after 0.6s, unless motion is reduced.

### Example Review (signature component)
An interactive pull request drawn in FTDS, not GitHub's chrome: a header with the PR title and a check state (Danger dot and "failing" or Success dot and "passing"), a Paper summary comment with counts and score, then a monospace diff with 3rem line-number gutter, wash-coloured added and removed lines, and finding threads inset under their lines. A thread is a Sheet with a 1px ring in its severity's Edge colour; once resolved it turns Paper with a Success Edge ring and a check. One primary button ("Push the fix") switches the whole component between its two states via a single attribute, crossfading changed parts over 0.35s; without JavaScript the button stays hidden and the first state stands alone.

## Do's and Don'ts

### Do:
- **Do** build from FTDS tokens and FTDS components first; this file only records what FiscalCR adds.
- **Do** open on the Review Field and close on a Field band, with Sheet and Paper alternating between.
- **Do** put anything on the Field or the Stage inside `.on-field`, so focus rings and selection turn white.
- **Do** use the solid and quiet field buttons on the Field, not FTDS's filled primary.
- **Do** show configuration and workflow files as dark code blocks, with a copy button where the reader will paste it.
- **Do** keep severity colour tied to a real finding, diff line or check state, and label every example review as an example.
- **Do** give every animation a still, complete reduced-motion state.

### Don't:
- **Don't** add a palette, typeface, radius or shadow of FiscalCR's own; the Field, Stage and finding colours are FTDS primitives with roles.
- **Don't** make the Stage full-bleed or put it on white.
- **Don't** use danger, warning or success colours as decoration or brand accents.
- **Don't** cast shadows on Sheet or Paper; the Field lift is for white objects floating on the Field.
- **Don't** imitate GitHub's own interface; draw reviews in FTDS.
- **Don't** use the hero display size anywhere but the h1.
