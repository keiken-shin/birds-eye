# Docs refresh: research and implementation brief

Date: 2026-08-15  
Branch: `codex/docs-refresh-2026-08`

## Objective

Make the documentation site do two jobs without confusing them:

1. Help a first-time visitor decide whether Bird's Eye is worth installing.
2. Help users and contributors complete a task without rereading the product pitch.

The product has changed since the previous docs pass. The relationship canvas labelled
**Findings** is gone. Its useful review work now lives in **Clean up**, and view 3 is a durable
**Staged** workspace for items a person has set aside. The old screenshot and demo therefore show
a workflow that no longer exists.

## What the market says

The established Windows disk-analysis tools lead with speed, visualization, or breadth:

- [WizTree](https://wize-tree.com/) leads with scan speed, MFT access, accuracy, and its treemap.
- [TreeSize](https://www.jam-software.com/treesize/features.shtml) leads with fast scans,
  Explorer integration, filters, reporting, and storage views.
- [WinDirStat](https://www.windirstat.dev/) leads with its directory list, treemap, and
  extension breakdown.

That is useful context, but it leaves Bird's Eye a clearer position than “another disk map”:
**show the evidence behind a deletion decision, then make the action reviewable and reversible.**
The site should prove that difference with a real recommendation row and the Staged → Review
workflow before it inventories features.

Trust matters more than urgency in this category. The FTC's
[Office Depot PC check-up case](https://www.ftc.gov/news-events/news/press-releases/2019/03/office-depot-tech-support-firm-will-pay-35-million-settle-ftc-allegations-they-tricked-consumers)
is a concrete reminder that unsupported “problems found” claims and fear-based repair prompts
damage users. Bird's Eye should continue to reject health scores, issue counters, countdowns,
and automatic deletion. The copy should name what the app found, why it reached that conclusion,
and what will happen next.

## Documentation model

The information architecture borrows the useful distinction in
[Diátaxis](https://diataxis.fr/application/): learning, doing, reference, and explanation are
different reader needs. This site is small enough that those needs do not require four literal
buckets, but pages should still have one job.

### Marketing home

The home page is the decision page. It should answer, in the first viewport:

- What is this?
- What does it do that a disk map does not?
- Why is it safe to try?
- Where do I get it?

The proof order is recommendation → stage → review → reversible action. Installation is the
primary action. Source code is supporting proof, not a competing hero action.

### Guides

- **Getting started:** install, scan, read the first recommendation, and stage one item.
- **The workspace:** reference for the eight views and the persistent rails/panels.
- **Stage, group, and review:** the new task guide for the decision workflow.
- **Working safely:** review, recovery, privacy, and explicit limitations.

### Develop

Keep architecture, build, contribution, and release details separate from user guidance.
Developer pages may use internal names such as ontology, predicates, DTOs, and migrations when
those are the precise code terms.

## Writing decisions

Microsoft's guidance on
[scannable content](https://learn.microsoft.com/en-us/style-guide/scannable-content/) says to
lead with the information a customer needs, use short sections, and give long pages internal
navigation. Google's
[heading guidance](https://developers.google.com/style/headings) reinforces sentence case and
logical hierarchy. [MDN's writing guide](https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Writing_style_guide)
adds active voice, unambiguous pronouns, descriptive links, and examples that explain what they do.

For Bird's Eye, that becomes:

- Put the result before the mechanism.
- Use the product's real nouns: scan, recommendation, Stage, Staged, Review, Recycle Bin.
- Show a size, a last-touched date, and a reason together.
- Use second person in procedures and active voice everywhere else.
- Keep internal vocabulary in developer docs.
- Avoid unsupported superlatives, testimonials, fake precision, and invented benchmarks.
- Say what the product cannot or does not do when that boundary builds trust.

## Visual and interaction decisions

The existing dark Bird's Eye visual system remains the authority: near-black surfaces, one
spring-green action color, Space Grotesk for reading, and JetBrains Mono for paths and measured
data. The refresh changes composition, not identity.

- Use a split hero so the real product screen shares the first viewport with the promise.
- Replace the old canvas mockup with the current Staged screen.
- Replace the old feature-tour demo with one workflow: recommendation → stage → Staged → review.
- Keep guide pages quieter than the marketing home.
- Keep readable lines near 65–75 characters.
- Preserve visible focus, reduced-motion behavior, a skip link, current-page states, and search.

The site already has global navigation, local page contents, and search. That satisfies the
spirit of WCAG's
[multiple-ways guidance](https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways) and should be
kept as the site grows.

## Search and sharing

- Each page gets a unique title, description, canonical URL, and searchable text.
- The home page uses `SoftwareApplication` JSON-LD with only verified properties. Google's
  [software-app documentation](https://developers.google.com/search/docs/appearance/structured-data/software-app)
  supports the app type, operating system, and a free offer.
- Social previews use the current Staged screen rather than the app icon.
- Keep the generated sitemap and add an explicit `robots.txt` pointer to it.
- Keep every subresource self-hosted; the offline promise should also be true of the docs build.

## Asset workflow

`scripts/capture-doc-assets.cjs` drives the browser-mode mock app at a fixed 1600 × 1000
viewport. It captures:

1. Overview.
2. Clean up with the reason rows visible.
3. Selected items in the persistent tray.
4. The Staged decision workspace.
5. The Review gate.

The current Staged frame becomes `docs/assets/screenshots/staged.png`. The workflow frames are
assembled into `docs/assets/demo.gif`. The mock backend makes the capture deterministic and keeps
personal file data out of the repository.

## Acceptance criteria

- No user-facing page or README describes the retired Findings canvas.
- The eight current labels appear consistently: Overview, Map, Staged, Files, Duplicates,
  Clean up, By age, Organise.
- Finding confirmation is documented inside Clean up.
- Staging is documented as durable, groupable, and scoped to the items the user reviewed.
- The new screenshot and demo are generated from the current UI.
- The docs build, self-test, copy gate, link checks, and frontend build pass.
- Desktop and mobile captures have no clipped navigation, unreadable copy, or horizontal page
  overflow.

