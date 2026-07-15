# Contributing

Issues and pull requests are welcome. Bird's Eye has a strong point of view — safety,
privacy, and a calm design language — and the bar for a change is that it keeps that point
of view intact.

## What a good change keeps intact

1. **The safety model.** No new path to disk mutation may skip the Review gate, and the
   cleanup safety predicate (`src/ontology/cleanup/predicate.rs`) must keep holding back
   protected paths. This is non-negotiable — see [Working safely](../guide/working-safely.md).
2. **The gates stay green.** `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and
   `npm run build` all pass.
3. **The design system.** Use the tokens in `workspace/src/index.css` and the shared
   primitives in `workspace/src/components/ui/`. No hardcoded colors; lucide icons only.
   The [Brand](../brand.md) page has the details.

## Before you open a PR

Run the full verification suite from [Building from source](building.md#verify):

```powershell
cargo test
cargo check --manifest-path src-tauri\Cargo.toml
cd workspace && npm run build && npx vitest run
```

Most UI work needs no Rust toolchain — `cd workspace && npm run dev` renders the whole
workspace against the mock backend. Iterate there, then run the gates.

## Commit style

Commits follow the conventional format:

```
<type>(<scope>): <subject>
```

For example: `feat(ontology): add installer-cache heuristic` or
`fix(cleanup): re-verify predicate at the review gate`.

## Privacy is a hard constraint

Bird's Eye never makes a network call with user data — no telemetry, no analytics, no
"phone home." A contribution that would send file paths, metadata, hashes, or contents off
the machine will not be accepted, however it's framed. When in doubt, keep it local.

## Reporting issues

Open an issue on [GitHub](https://github.com/keiken-shin/birds-eye/issues). A good report
says what you scanned (roughly), what you expected, what happened, and — for anything
touching cleanup — whether the Review gate behaved as documented.
