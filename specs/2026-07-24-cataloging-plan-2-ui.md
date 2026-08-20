# Cataloging Plan 2 — Catalog View & Manual Arrangement (React)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review relocation suggestions and arrange files by hand, through the workspace's existing stage → review → execute → undo rhythm.

**Architecture:** A new `CatalogView` stage renders `relocation` discovery cards. Accepting one stages it into a **separate `stagedMoves`** store field — never the delete-scoped `staged` array — which a new `RelocateReviewModal` turns into a plan and executes. The Cleanup Tray learns to hold both kinds. The Files view gains multi-select and a bulk **Move to…**, which offers to save the arrangement as a rule.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4 (token-only), vitest + jsdom. All commands run from `workspace/`.

## Global Constraints

- **Depends on Plan 1.** Every command named here must exist in `src/native/api.rs` and be registered in `src-tauri/src/main.rs` first.
- Rust field names cross the wire **snake_case verbatim** — there is no `rename_all`. TS mirror types use snake_case for payload fields (`plan_id`, `total_bytes`, `from_path`).
- New `nativeClient` wrappers use the `request` arg form: ``invoke<T>("cmd", { request: { index_path: indexPath, ... } })``. Optional values normalize with `?? null`.
- **Every new wrapper needs a `mockBackend.ts` case** — the `switch` rejects unhandled commands, so browser dev-mode breaks without one.
- `workspaceStore` changes must land in **four synchronized places**: the `WorkspaceState` field, the `WorkspaceActions` signature, the `useMemo` value object, and the `useMemo` dependency array. Raw `useState` setters go in the value but **not** the deps.
- Styling is token-only (`text-ink`, `bg-field`, `border-line`, `text-115`, …). Never a raw hex or an arbitrary pixel colour.
- **Tests are pure-function unit tests next to their source as `<name>.test.ts`.** The repo has zero `.tsx` component tests — do not introduce a component-testing pattern here.
- Verification gates (from `workspace/`):
  ```bash
  npx tsc --noEmit
  ```
  ```bash
  npx vitest run
  ```
  ```bash
  npm run build
  ```
- There is no eslint and no prettier. Do not add one.

---

### Task 1: Store — staged moves, review discriminant, undo union

**Files:**
- Modify: `workspace/src/state/types.ts`, `workspace/src/state/workspaceStore.tsx`
- Modify: `workspace/src/components/ReviewModal.tsx` (the `review` guard only)

**Interfaces:**
- Produces:
  - `export type StagedMove = { path: string; name: string; bytes: number; to: string; destinationExists: boolean; fileId: number; discoveryId: number | null };`
  - `export type ReviewMode = "clean" | "relocate" | null;`
  - `export type UndoState = { kind: "clean"; entryIds: number[]; freed: number } | { kind: "relocate"; pairs: Array<{ from: string; to: string }> } | null;`
  - Store gains `stagedMoves: StagedMove[]`, `toggleStagedMove(move)`, `isMoveStaged(path)`, `clearStagedMoves()`, `openRelocateReview()`, and `review: ReviewMode`.

- [ ] **Step 1: Write the failing test**

Create `workspace/src/lib/undo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reversePairs } from "./undo";

describe("reversePairs", () => {
  it("swaps from and to so a move can be undone by move_files", () => {
    expect(
      reversePairs([
        { from: "C:\\Inbox\\a.exe", to: "D:\\Software\\a.exe" },
        { from: "C:\\Inbox\\b.exe", to: "D:\\Software\\b.exe" },
      ])
    ).toEqual([
      { from: "D:\\Software\\a.exe", to: "C:\\Inbox\\a.exe" },
      { from: "D:\\Software\\b.exe", to: "C:\\Inbox\\b.exe" },
    ]);
  });

  it("is its own inverse", () => {
    const pairs = [{ from: "a", to: "b" }];
    expect(reversePairs(reversePairs(pairs))).toEqual(pairs);
  });

  it("handles an empty result", () => {
    expect(reversePairs([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/undo.test.ts`
Expected: FAIL — `Failed to resolve import "./undo"`.

- [ ] **Step 3: Write minimal implementation**

Create `workspace/src/lib/undo.ts`:

```ts
/** Undoing a relocation is just moving every file back — no dedicated command. */
export function reversePairs(pairs: Array<{ from: string; to: string }>) {
  return pairs.map((pair) => ({ from: pair.to, to: pair.from }));
}
```

In `workspace/src/state/types.ts`, append `"catalog"` to `StageView`, then replace the `UndoState` line and add the new types next to `StagedItem`:

```ts
/**
 * A staged relocation. Deliberately NOT a StagedItem: that type has no action
 * discriminant and no destination, and ReviewModal feeds every staged path to
 * cleanup_plan as a delete scope prefix.
 */
export type StagedMove = {
  path: string;
  name: string;
  bytes: number;
  /** Absolute destination path for this one file. */
  to: string;
  destinationExists: boolean;
  fileId: number;
  discoveryId: number | null;
};

/** Which review gate is open. Both kinds can be staged at once. */
export type ReviewMode = "clean" | "relocate" | null;

export type UndoState =
  | { kind: "clean"; entryIds: number[]; freed: number }
  | { kind: "relocate"; pairs: Array<{ from: string; to: string }> }
  | null;
```

In `workspace/src/state/workspaceStore.tsx`:

State field and declaration:

```ts
  stagedMoves: StagedMove[];
```
```ts
  const [stagedMoves, setStagedMoves] = useState<StagedMove[]>([]);
```

Change `review` in `WorkspaceState` from `boolean` to `ReviewMode`, and its declaration:

```ts
  const [review, setReview] = useState<ReviewMode>(null);
```

Actions (add to `WorkspaceActions`, and implement next to `toggleStaged`):

```ts
  toggleStagedMove: (move: StagedMove) => void;
  isMoveStaged: (path: string) => boolean;
  clearStagedMoves: () => void;
  openRelocateReview: () => void;
```
```ts
  const toggleStagedMove = useCallback((move: StagedMove) => {
    setStagedMoves((prev) => {
      const i = prev.findIndex((s) => s.path === move.path);
      if (i >= 0) return prev.filter((_, k) => k !== i);
      return [...prev, move];
    });
  }, []);
  const isMoveStaged = useCallback(
    (path: string) => stagedMoves.some((s) => s.path === path),
    [stagedMoves]
  );
  const clearStagedMoves = useCallback(() => setStagedMoves([]), []);
  const openRelocateReview = useCallback(() => {
    if (stagedMoves.length) setReview("relocate");
  }, [stagedMoves.length]);
```

Update the two existing review actions:

```ts
  const closeReview = useCallback(() => setReview(null), []);
```
```ts
  const openReview = useCallback(() => {
    if (staged.length) setReview("clean");
    else if (stagedMoves.length) setReview("relocate");
  }, [staged.length, stagedMoves.length]);
```

> `openReview` is what global ⌘Enter calls (`WorkspaceShell.tsx:40-43`) — it needs **zero** changes there because the discrimination now lives in the store.

Add `stagedMoves`, `toggleStagedMove`, `isMoveStaged`, `clearStagedMoves`, `openRelocateReview` to **both** the `useMemo` value object and its dependency array, mirroring declaration order.

In `workspace/src/components/ReviewModal.tsx`, tighten the guard so the cleanup gate only opens for cleanups:

```tsx
  if (review !== "clean") return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/undo.test.ts`
Expected: PASS — 3 tests.

Run: `npx tsc --noEmit`
Expected: errors ONLY where `UndoState` consumers still assume the old shape — fix each by branching on `undo.kind`. `UndoToast` is handled in Task 6.

- [ ] **Step 5: Commit**

```bash
git add workspace/src/state workspace/src/lib/undo.ts workspace/src/lib/undo.test.ts workspace/src/components/ReviewModal.tsx && git commit -m "feat(catalog): add staged moves, a review discriminant, and a relocate undo shape"
```

---

### Task 2: Bridge — wrappers and mocks

**Files:**
- Modify: `workspace/src/bridge/nativeClient.ts`, `workspace/src/dev/mockBackend.ts`

**Interfaces:**
- Consumes: Plan 1 commands.
- Produces: `NativeRelocationPayload`, `NativeRelocationMember`, `NativeRelocationPlan`, `NativeRelocationResult`, `NativeCatalogRule`, and the wrappers `relocationCards`, `relocationMembers`, `buildRelocationPlan`, `executeRelocationPlan`, `catalogRules`, `saveCatalogRule`, `deleteCatalogRule`, `rejectDiscovery` (existing).

- [ ] **Step 1: Add the wrappers**

Append to `workspace/src/bridge/nativeClient.ts` under a new banner `// ---- Ontology: cataloging ----`:

```ts
export type NativeRelocationMember = {
  file_id: number;
  path: string;
  name: string;
  size: number;
};

export type NativeRelocationPayload = {
  fingerprint: string;
  member_hash: string;
  destination: string;
  destination_exists: boolean;
  source: "rule" | "learned" | "template";
  reason: string;
  zone: string;
  kind: string;
  member_count: number;
  total_bytes: number;
  members: NativeRelocationMember[];
};

export type NativeRelocationPlanItem = {
  id: number;
  file_id: number;
  from_path: string;
  to_path: string;
  size: number;
  status: string;
  note: string | null;
};

export type NativeRelocationPlan = {
  plan_id: number;
  total_files: number;
  total_bytes: number;
  items: NativeRelocationPlanItem[];
  dropped: Array<{ path: string; reason: string }>;
};

export type NativeRelocationResult = {
  plan_id: number;
  moved: number;
  bytes_moved: number;
  pairs: Array<{ from: string; to: string }>;
  failed: Array<{ path: string; reason: string }>;
};

export type NativeCatalogRule = {
  id: number;
  name: string;
  criteria: { kind: string | null; name_contains: string | null; zone: string | null };
  destination: string;
  source: string;
  enabled: boolean;
};

/** Pending relocation cards. Reuses the discoveries queue, filtered by kind. */
export async function relocationCards(indexPath: string, limit = 50) {
  return invoke<NativeDiscovery[]>("discoveries", {
    request: { index_path: indexPath, kind: "relocation", limit },
  });
}

/** The full member list for one card — the payload embeds only the first 50. */
export async function relocationMembers(indexPath: string, discoveryId: number) {
  return invoke<NativeRelocationMember[]>("relocation_members", {
    request: { index_path: indexPath, discovery_id: discoveryId },
  });
}

/** Re-verify the staged moves and persist a draft plan. */
export async function buildRelocationPlan(
  indexPath: string,
  moves: Array<{ file_id: number; from: string; to: string; discovery_id: number | null }>
) {
  return invoke<NativeRelocationPlan>("relocation_plan", {
    request: { index_path: indexPath, moves },
  });
}

export async function executeRelocationPlan(indexPath: string, planId: number) {
  return invoke<NativeRelocationResult>("execute_relocation_plan", {
    request: { index_path: indexPath, plan_id: planId },
  });
}

export async function catalogRules(indexPath: string) {
  return invoke<NativeCatalogRule[]>("catalog_rules", {
    request: { index_path: indexPath },
  });
}

export async function saveCatalogRule(
  indexPath: string,
  rule: {
    name: string;
    kind?: string | null;
    nameContains?: string | null;
    zone?: string | null;
    destination: string;
    source: "saved-after-move" | "saved-after-edit";
  }
) {
  return invoke<number>("save_catalog_rule", {
    request: {
      index_path: indexPath,
      name: rule.name,
      kind: rule.kind ?? null,
      name_contains: rule.nameContains ?? null,
      zone: rule.zone ?? null,
      destination: rule.destination,
      source: rule.source,
    },
  });
}

export async function deleteCatalogRule(indexPath: string, id: number) {
  await invoke("delete_catalog_rule", { request: { index_path: indexPath, id } });
}
```

> If `DiscoveriesRequest` in Rust has no `kind` field, add `#[serde(default)] pub kind: Option<String>` to it and filter in `discoveries()` — a one-line change in Plan 1's Task 10 scope. Otherwise filter client-side by `d.kind === "relocation"`.

- [ ] **Step 2: Add the mock cases**

Add to the `switch (cmd)` in `workspace/src/dev/mockBackend.ts`, near the existing discovery cases. Declare the fixtures at module level next to the other `let` fixtures:

```ts
let RELOCATION_CARDS = [
  {
    id: 9001,
    kind: "relocation",
    status: "pending",
    confidence: 0.91,
    potential_bytes_unlocked: 4_812_000_000,
    created_at: 1_800_000_000,
    resolved_at: null,
    payload: JSON.stringify({
      fingerprint: "fp-installers",
      member_hash: "mh-1",
      destination: "D:\\Software\\Installers",
      destination_exists: true,
      source: "learned",
      reason: "87% of your installers already live here",
      zone: "C:\\Users\\alex\\Downloads",
      kind: "installer",
      member_count: 14,
      total_bytes: 4_812_000_000,
      members: Array.from({ length: 14 }, (_, i) => ({
        file_id: 5000 + i,
        path: `C:\\Users\\alex\\Downloads\\setup-${i}.exe`,
        name: `setup-${i}.exe`,
        size: 343_714_285,
      })),
    }),
  },
  {
    id: 9002,
    kind: "relocation",
    status: "pending",
    confidence: 0.55,
    potential_bytes_unlocked: 92_000_000,
    created_at: 1_800_000_000,
    resolved_at: null,
    payload: JSON.stringify({
      fingerprint: "fp-shots",
      member_hash: "mh-2",
      destination: "C:\\Users\\alex\\Pictures\\Screenshots",
      destination_exists: false,
      source: "template",
      reason: "screenshots usually belong together",
      zone: "C:\\Users\\alex\\Desktop",
      kind: "screenshot",
      member_count: 31,
      total_bytes: 92_000_000,
      members: Array.from({ length: 31 }, (_, i) => ({
        file_id: 6000 + i,
        path: `C:\\Users\\alex\\Desktop\\Screenshot ${i}.png`,
        name: `Screenshot ${i}.png`,
        size: 2_967_741,
      })),
    }),
  },
];

let CATALOG_RULES: Array<Record<string, unknown>> = [];
/** Flip to true in the browser console to exercise the review gate's error path. */
export let mockRelocationFails = false;
```

```ts
    case "relocation_members": {
      const id = Number(request.discovery_id);
      const card = RELOCATION_CARDS.find((c) => c.id === id);
      if (!card) return done([]);
      return done(JSON.parse(card.payload).members);
    }

    case "relocation_plan": {
      const moves = (request.moves ?? []) as Array<{
        file_id: number;
        from: string;
        to: string;
        discovery_id: number | null;
      }>;
      // One dropped item whenever more than three are staged, so the "dropped"
      // branch of the review gate is reachable in the browser.
      const dropped = moves.length > 3 ? [{ path: moves[0].from, reason: "no longer on disk" }] : [];
      const kept = moves.slice(dropped.length);
      return done({
        plan_id: 4242,
        total_files: kept.length,
        total_bytes: kept.length * 100_000_000,
        items: kept.map((m, i) => ({
          id: i + 1,
          file_id: m.file_id,
          from_path: m.from,
          to_path: m.to,
          size: 100_000_000,
          status: "planned",
          note: null,
        })),
        dropped,
      });
    }

    case "execute_relocation_plan": {
      const planId = Number(request.plan_id);
      if (mockRelocationFails) {
        return done({
          plan_id: planId,
          moved: 0,
          bytes_moved: 0,
          pairs: [],
          failed: [{ path: "C:\\Users\\alex\\Downloads\\setup-0.exe", reason: "locked by another process" }],
        });
      }
      const card = RELOCATION_CARDS[0];
      const payload = JSON.parse(card.payload);
      const pairs = payload.members.slice(0, 3).map((m: { path: string; name: string }) => ({
        from: m.path,
        to: `${payload.destination}\\${m.name}`,
      }));
      RELOCATION_CARDS = RELOCATION_CARDS.filter((c) => c.id !== card.id);
      return done({
        plan_id: planId,
        moved: pairs.length,
        bytes_moved: pairs.length * 100_000_000,
        pairs,
        failed: [],
      });
    }

    case "catalog_rules":
      return done(CATALOG_RULES);

    case "save_catalog_rule": {
      const id = CATALOG_RULES.length + 1;
      CATALOG_RULES = [
        ...CATALOG_RULES,
        {
          id,
          name: request.name,
          criteria: {
            kind: request.kind ?? null,
            name_contains: request.name_contains ?? null,
            zone: request.zone ?? null,
          },
          destination: request.destination,
          source: request.source,
          enabled: true,
        },
      ];
      return done(id);
    }

    case "delete_catalog_rule": {
      CATALOG_RULES = CATALOG_RULES.filter((r) => r.id !== Number(request.id));
      return done(undefined);
    }
```

Also extend the existing `discoveries` case to honour a `kind` filter and include `RELOCATION_CARDS`:

```ts
    case "discoveries": {
      const kind = request.kind ? String(request.kind) : null;
      const all = [...DISCOVERIES, ...RELOCATION_CARDS];
      const rows = kind ? all.filter((d) => d.kind === kind) : all.filter((d) => d.kind !== "relocation");
      return done(rows.filter((d) => d.status === "pending"));
    }
```

Extend the existing `reject_discovery` case to drop relocation cards too:

```ts
      RELOCATION_CARDS = RELOCATION_CARDS.filter((c) => c.id !== Number(request.id));
```

- [ ] **Step 3: Verify the browser path**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`, open the app, and in the console run `await window.__TAURI__ === undefined` to confirm mock mode. No command should reject.

- [ ] **Step 4: Commit**

```bash
git add workspace/src/bridge/nativeClient.ts workspace/src/dev/mockBackend.ts && git commit -m "feat(catalog): bridge and mock the cataloging commands"
```

---

### Task 3: Card ranking and parsing helpers

**Files:**
- Create: `workspace/src/lib/catalog.ts`, `workspace/src/lib/catalog.test.ts`

**Interfaces:**
- Consumes: `NativeDiscovery`, `NativeRelocationPayload`.
- Produces:
  - `export type RelocationCard = { id: number; confidence: number; payload: NativeRelocationPayload };`
  - `export function parseCards(rows: NativeDiscovery[]): RelocationCard[]`
  - `export function rankCards(cards: RelocationCard[]): RelocationCard[]`
  - `export function sourceLabel(source: string): string`
  - `export function destinationFor(destination: string, name: string): string`

- [ ] **Step 1: Write the failing test**

Create `workspace/src/lib/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { destinationFor, parseCards, rankCards, sourceLabel } from "./catalog";

const card = (id: number, confidence: number, bytes: number, count: number) => ({
  id,
  kind: "relocation",
  status: "pending",
  confidence,
  potential_bytes_unlocked: bytes,
  created_at: 0,
  resolved_at: null,
  payload: JSON.stringify({
    fingerprint: `fp${id}`,
    member_hash: `mh${id}`,
    destination: "D:\\Docs",
    destination_exists: true,
    source: "learned",
    reason: "because",
    zone: "C:\\Inbox",
    kind: "document",
    member_count: count,
    total_bytes: bytes,
    members: [],
  }),
});

describe("parseCards", () => {
  it("parses the payload of each row", () => {
    const parsed = parseCards([card(1, 0.9, 100, 2)] as never);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].payload.destination).toBe("D:\\Docs");
    expect(parsed[0].payload.member_count).toBe(2);
  });

  it("drops a row whose payload is not valid JSON rather than throwing", () => {
    const broken = { ...card(1, 0.9, 100, 2), payload: "{not json" };
    expect(parseCards([broken] as never)).toEqual([]);
  });
});

describe("rankCards", () => {
  it("ranks by impact weighted by confidence", () => {
    const ranked = rankCards(
      parseCards([
        card(1, 0.5, 1_000, 2), // 2 * 1000 * 0.5  = 1000
        card(2, 0.9, 1_000, 5), // 5 * 1000 * 0.9  = 4500
        card(3, 0.9, 100, 1), //   1 * 100  * 0.9  = 90
      ] as never)
    );
    expect(ranked.map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it("does not mutate its input", () => {
    const cards = parseCards([card(1, 0.5, 10, 1), card(2, 0.9, 100, 9)] as never);
    const order = cards.map((c) => c.id);
    rankCards(cards);
    expect(cards.map((c) => c.id)).toEqual(order);
  });
});

describe("sourceLabel", () => {
  it("names each destination source", () => {
    expect(sourceLabel("rule")).toBe("Your rule");
    expect(sourceLabel("learned")).toBe("Learned");
    expect(sourceLabel("template")).toBe("Convention");
    expect(sourceLabel("weird")).toBe("Suggested");
  });
});

describe("destinationFor", () => {
  it("joins with the separator the destination already uses", () => {
    expect(destinationFor("D:\\Docs", "a.pdf")).toBe("D:\\Docs\\a.pdf");
    expect(destinationFor("/home/a/docs", "a.pdf")).toBe("/home/a/docs/a.pdf");
  });

  it("does not double a trailing separator", () => {
    expect(destinationFor("D:\\Docs\\", "a.pdf")).toBe("D:\\Docs\\a.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/catalog.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog"`.

- [ ] **Step 3: Write minimal implementation**

Create `workspace/src/lib/catalog.ts`:

```ts
import type { NativeDiscovery, NativeRelocationPayload } from "@bridge/nativeClient";

export type RelocationCard = {
  id: number;
  confidence: number;
  payload: NativeRelocationPayload;
};

/** A row whose payload will not parse is dropped, never rendered half-built. */
export function parseCards(rows: NativeDiscovery[]): RelocationCard[] {
  const cards: RelocationCard[] = [];
  for (const row of rows) {
    try {
      cards.push({
        id: row.id,
        confidence: row.confidence,
        payload: JSON.parse(row.payload) as NativeRelocationPayload,
      });
    } catch {
      // Unparseable payload — skip it rather than break the view.
    }
  }
  return cards;
}

/** Impact (how many files, how many bytes) discounted by how sure we are. */
function score(card: RelocationCard) {
  return card.payload.member_count * card.payload.total_bytes * card.confidence;
}

export function rankCards(cards: RelocationCard[]): RelocationCard[] {
  return cards.slice().sort((a, b) => score(b) - score(a));
}

export function sourceLabel(source: string) {
  switch (source) {
    case "rule":
      return "Your rule";
    case "learned":
      return "Learned";
    case "template":
      return "Convention";
    default:
      return "Suggested";
  }
}

/** Join a destination folder and a filename using the folder's own separator. */
export function destinationFor(destination: string, name: string) {
  const sep = destination.includes("/") && !destination.includes("\\") ? "/" : "\\";
  return destination.replace(/[\\/]+$/, "") + sep + name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/catalog.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add workspace/src/lib/catalog.ts workspace/src/lib/catalog.test.ts && git commit -m "feat(catalog): add card parsing, ranking, and destination helpers"
```

---

### Task 4: The Catalog view

**Files:**
- Create: `workspace/src/components/views/CatalogView.tsx`
- Modify: `workspace/src/components/CenterStage.tsx`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `export function CatalogView()`.

- [ ] **Step 1: Write the component**

Create `workspace/src/components/views/CatalogView.tsx`. Mirror `CleanupView`'s structure: `ViewHeader` at the top of the default export, a body that branches on intelligence state, and `picked`-style local selection.

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  rejectDiscovery,
  relocationCards,
  relocationMembers,
  type NativeRelocationMember,
} from "@bridge/nativeClient";
import { destinationFor, parseCards, rankCards, sourceLabel, type RelocationCard } from "../../lib/catalog";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { EnableIntelligenceCard } from "../EnableIntelligenceCard";
import { Button } from "../ui/Button";
import { Card, SectionLabel } from "../ui/Card";
import { ViewHeader } from "./ViewHeader";

/**
 * Relocation suggestions: "these files belong somewhere else". Accepting a card
 * stages its members as moves; nothing touches disk until the review gate.
 *
 * Written as a body component under its own ViewHeader so that if Cleanup and
 * Catalog are ever merged behind one header, the toggle drops into a parent and
 * this body is untouched.
 */
export function CatalogView() {
  // `ontologyEnabled` lives on the workspace store; `ontology` (the status DTO)
  // comes from indexData. They are NOT on the same hook.
  const { indexPath, ontologyEnabled, toggleStagedMove, isMoveStaged } = useWorkspace();
  const { ontology } = useIndexData();

  const [cards, setCards] = useState<RelocationCard[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [members, setMembers] = useState<Record<number, NativeRelocationMember[]>>({});
  const [excluded, setExcluded] = useState<Record<number, Set<string>>>({});

  const load = useCallback(async () => {
    if (!indexPath) return;
    const rows = await relocationCards(indexPath);
    setCards(rankCards(parseCards(rows)));
  }, [indexPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const expand = useCallback(
    async (card: RelocationCard) => {
      if (expanded === card.id) {
        setExpanded(null);
        return;
      }
      setExpanded(card.id);
      if (!members[card.id] && indexPath) {
        // The payload embeds only the first 50 members; the rest load lazily.
        const full = await relocationMembers(indexPath, card.id);
        setMembers((prev) => ({ ...prev, [card.id]: full }));
      }
    },
    [expanded, members, indexPath]
  );

  const membersOf = useCallback(
    (card: RelocationCard) => members[card.id] ?? card.payload.members,
    [members]
  );

  const accept = useCallback(
    (card: RelocationCard) => {
      const skip = excluded[card.id] ?? new Set<string>();
      for (const member of membersOf(card)) {
        if (skip.has(member.path)) continue;
        toggleStagedMove({
          path: member.path,
          name: member.name,
          bytes: member.size,
          to: destinationFor(card.payload.destination, member.name),
          destinationExists: card.payload.destination_exists,
          fileId: member.file_id,
          discoveryId: card.id,
        });
      }
      setCards((prev) => prev?.filter((c) => c.id !== card.id) ?? null);
    },
    [excluded, membersOf, toggleStagedMove]
  );

  const reject = useCallback(
    async (card: RelocationCard) => {
      setCards((prev) => prev?.filter((c) => c.id !== card.id) ?? null);
      if (indexPath) await rejectDiscovery(indexPath, card.id);
    },
    [indexPath]
  );

  const total = useMemo(
    () => (cards ?? []).reduce((sum, c) => sum + c.payload.total_bytes, 0),
    [cards]
  );

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Catalog"
        sub={
          cards?.length
            ? `${cards.length} suggestion${cards.length === 1 ? "" : "s"} · ${formatBytes(total)}`
            : "Where your files should live"
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {/* `ontology === null` means "not loaded yet" — without this guard the
            enable CTA flashes on every startup. */}
        {/* EnableIntelligenceCard already renders its own Card — do not wrap it. */}
        {ontology && !ontologyEnabled ? (
          <div className="mt-6">
            <EnableIntelligenceCard />
          </div>
        ) : cards === null ? (
          <p className="mt-6 text-12 italic text-label">Looking for misplaced files…</p>
        ) : cards.length === 0 ? (
          <Card className="mt-6">
            <SectionLabel>Nothing to move</SectionLabel>
            <p className="mt-2 text-125 text-dim">
              Everything in your inbox folders already looks like it is where it belongs.
            </p>
          </Card>
        ) : (
          <div className="mt-4 flex flex-col gap-2.5">
            {cards.map((card) => {
              const open = expanded === card.id;
              const skip = excluded[card.id] ?? new Set<string>();
              const list = membersOf(card);
              const keeping = list.filter((m) => !skip.has(m.path));
              return (
                <Card key={card.id}>
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => void expand(card)}
                      aria-expanded={open}
                      className="mt-0.5 flex-none text-faint transition-colors hover:text-ink"
                      title={open ? "Collapse" : "Show files"}
                    >
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-135 text-ink">
                        {card.payload.member_count} {card.payload.kind}
                        {card.payload.member_count === 1 ? "" : "s"} → {card.payload.destination}
                      </p>
                      <p className="mt-1 text-115 text-dim">
                        {card.payload.reason}
                        {card.payload.destination_exists ? null : (
                          <span className="ml-2 rounded-full border border-line-modal px-2 py-0.5 text-105 text-faint">
                            will be created
                          </span>
                        )}
                      </p>
                      <p className="mono mt-1 text-105 text-faint">
                        {sourceLabel(card.payload.source)} · {formatBytes(card.payload.total_bytes)}
                        {keeping.length === list.length
                          ? null
                          : ` · ${list.length - keeping.length} excluded`}
                      </p>
                    </div>
                    <div className="flex flex-none gap-1.5">
                      <Button
                        variant="primary"
                        icon={Check}
                        disabled={keeping.length === 0}
                        onClick={() => accept(card)}
                      >
                        Accept
                      </Button>
                      <Button icon={X} onClick={() => void reject(card)}>
                        Not this
                      </Button>
                    </div>
                  </div>

                  {open ? (
                    <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
                      {list.map((member) => {
                        const off = skip.has(member.path);
                        return (
                          <li key={member.path} className="flex items-center gap-2 text-115">
                            <input
                              type="checkbox"
                              checked={!off}
                              aria-label={`Include ${member.name}`}
                              onChange={() =>
                                setExcluded((prev) => {
                                  const next = new Set(prev[card.id] ?? []);
                                  if (off) next.delete(member.path);
                                  else next.add(member.path);
                                  return { ...prev, [card.id]: next };
                                })
                              }
                            />
                            <span className={`min-w-0 flex-1 truncate ${off ? "text-faint line-through" : "text-dim"}`}>
                              {member.name}
                            </span>
                            <span className="mono flex-none text-105 text-faint">
                              {formatBytes(member.size)}
                            </span>
                            {isMoveStaged(member.path) ? (
                              <span className="flex-none text-105 text-primary-ink">staged</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

> Check `ViewHeader`, `Card`, `Button`, `SectionLabel`, and `EnableIntelligenceCard` prop signatures against their sources before compiling and adjust the call sites — this file follows `CleanupView.tsx:214-314` and must match whatever those primitives actually accept.

In `workspace/src/components/CenterStage.tsx`, add the import and the branch alongside the other views:

```tsx
import { CatalogView } from "./views/CatalogView";
```
```tsx
      {view === "catalog" ? <CatalogView /> : null}
```

- [ ] **Step 2: Verify it compiles and renders**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`, switch to the Catalog view. Expected: two mock cards, ranked with installers first; expanding loads the member list; excluding a file updates the count line.

- [ ] **Step 3: Commit**

```bash
git add workspace/src/components/views/CatalogView.tsx workspace/src/components/CenterStage.tsx && git commit -m "feat(catalog): add the Catalog view of relocation suggestions"
```

---

### Task 5: Cleanup Tray holds both kinds

**Files:**
- Modify: `workspace/src/components/CleanupTray.tsx`

**Interfaces:**
- Consumes: `stagedMoves`, `toggleStagedMove`, `openRelocateReview` from Task 1.

- [ ] **Step 1: Understand the hazard**

`CleanupTray` today reads **only** `staged`. It hardcodes the label "Cleanup tray", the button "Review & clean", `disabled={!staged.length}`, and the empty text "Nothing staged — select something and add it here." With relocations accepted and no cleanups staged, the tray reports **nothing staged** and its button is **disabled** — the accepted moves are invisible and unexecutable.

- [ ] **Step 2: Rewrite the component**

Replace the body of `workspace/src/components/CleanupTray.tsx`:

```tsx
import { ArrowRight, X } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { Button } from "./ui/Button";
import { SectionLabel } from "./ui/Card";

const MAX_CHIPS = 6;

/**
 * The staging bar. It holds two independent kinds — cleanups (delete-scoped)
 * and relocations (each with its own destination) — because the review gates
 * and backends behind them share nothing.
 */
export function CleanupTray() {
  const { staged, toggleStaged, openReview, stagedMoves, toggleStagedMove, openRelocateReview } =
    useWorkspace();

  const cleanBytes = staged.reduce((s, item) => s + item.bytes, 0);
  const moveBytes = stagedMoves.reduce((s, item) => s + item.bytes, 0);
  const count = staged.length + stagedMoves.length;

  const chips = [
    ...staged.map((item) => ({
      key: `clean:${item.path}`,
      path: item.path,
      label: item.name,
      bytes: item.bytes,
      hint: null as string | null,
      remove: () => toggleStaged(item),
    })),
    ...stagedMoves.map((item) => ({
      key: `move:${item.path}`,
      path: item.path,
      label: item.name,
      bytes: item.bytes,
      hint: item.to,
      remove: () => toggleStagedMove(item),
    })),
  ];
  const shown = chips.slice(0, MAX_CHIPS);
  const overflow = chips.length - shown.length;

  const label = staged.length && stagedMoves.length ? "Staged" : stagedMoves.length ? "Move tray" : "Cleanup tray";

  return (
    <div className="flex h-[60px] flex-none items-center gap-3 border-t border-line bg-bar px-3.5">
      <SectionLabel className="flex-none">{label}</SectionLabel>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {count ? (
          <>
            {shown.map((chip) => (
              <span
                key={chip.key}
                title={chip.hint ? `${chip.path} → ${chip.hint}` : chip.path}
                className="flex flex-none items-center gap-1.5 rounded-full border border-primary-edge bg-primary-dim py-1 pl-2.5 pr-1.5 text-115 text-primary-bright"
              >
                <span className="max-w-40 truncate">{chip.label}</span>
                {chip.hint ? <ArrowRight size={10} className="flex-none opacity-70" aria-hidden /> : null}
                <span className="mono text-primary-ink">{formatBytes(chip.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Unstage ${chip.label}`}
                  title={`Unstage ${chip.label}`}
                  onClick={chip.remove}
                  className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-faint transition-colors hover:text-ink"
                >
                  <X size={11} strokeWidth={2} aria-hidden />
                </button>
              </span>
            ))}
            {overflow > 0 ? (
              <span className="flex flex-none items-center rounded-full border border-line-modal px-2.5 py-1 text-115 text-faint">
                +{overflow} more
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-12 italic text-label">
            Nothing staged — select something and add it here.
          </span>
        )}
      </div>
      <span className="mono flex-none text-13 text-primary-ink">
        {formatBytes(cleanBytes + moveBytes)}
      </span>
      {staged.length ? (
        <Button variant="primary" icon={ArrowRight} onClick={openReview} className="flex-none">
          Review &amp; clean
        </Button>
      ) : null}
      {stagedMoves.length ? (
        <Button
          variant="primary"
          icon={ArrowRight}
          onClick={openRelocateReview}
          className="flex-none"
        >
          Review &amp; move
        </Button>
      ) : null}
      {count === 0 ? (
        <Button variant="primary" icon={ArrowRight} disabled className="flex-none">
          Review
        </Button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Verify both kinds coexist**

Run: `npm run dev`. Stage a cleanup from the Cleanup view **and** accept a Catalog card. Expected: chips of both kinds, relocate chips showing `→`, and **two** buttons.

> If the 60px bar reads badly with both buttons, the fallback is a second strip that appears only when `stagedMoves` is non-empty — uglier and unambiguous, still cheaper than a second nav dimension.

- [ ] **Step 4: Commit**

```bash
git add workspace/src/components/CleanupTray.tsx && git commit -m "feat(catalog): let the staging tray hold cleanups and relocations together"
```

---

### Task 6: The relocate review gate and undo

**Files:**
- Create: `workspace/src/components/RelocateReviewModal.tsx`
- Modify: `workspace/src/components/WorkspaceShell.tsx` (mount), `workspace/src/components/UndoToast.tsx`

**Interfaces:**
- Consumes: `buildRelocationPlan`, `executeRelocationPlan`, `moveFiles`, `reversePairs`.
- Produces: `export function RelocateReviewModal()`.

- [ ] **Step 1: Write the modal**

Create `workspace/src/components/RelocateReviewModal.tsx`. Reuse `OverlayShell`, the skeleton rows, and `ReviewModal`'s request-id/abort pattern; nothing else transfers.

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  buildRelocationPlan,
  executeRelocationPlan,
  type NativeRelocationPlan,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { Button } from "./ui/Button";
import { OverlayShell } from "./ui/OverlayShell";
import { SectionLabel } from "./ui/Card";

/** Review before moving. Re-verifies on the Rust side, then executes. */
export function RelocateReviewModal() {
  const { review, closeReview, stagedMoves, clearStagedMoves, indexPath, setUndo } = useWorkspace();
  const { refreshData } = useIndexData();
  const { view: scanView, enqueue } = useScanController();

  const [plan, setPlan] = useState<NativeRelocationPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Array<{ path: string; reason: string }>>([]);
  const reqId = useRef(0);

  useEffect(() => {
    if (review !== "relocate" || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setPlan(null);
    setFailures([]);

    void (async () => {
      try {
        const built = await buildRelocationPlan(
          indexPath,
          stagedMoves.map((m) => ({
            file_id: m.fileId,
            from: m.path,
            to: m.to,
            discovery_id: m.discoveryId,
          }))
        );
        if (id !== reqId.current) return;
        setPlan(built);
      } catch (e) {
        if (id !== reqId.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [review, indexPath, stagedMoves]);

  const execute = useCallback(async () => {
    if (!plan || !indexPath) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeRelocationPlan(indexPath, plan.plan_id);
      setFailures(result.failed);
      if (result.pairs.length) {
        setUndo({ kind: "relocate", pairs: result.pairs });
      }
      clearStagedMoves();
      await refreshData();
      // Unlike MoveDialog, always enqueue — the scan queue FIFOs.
      const root = stagedMoves[0]?.path ?? null;
      if (root) enqueue(root, "metadata");
      if (!result.failed.length) closeReview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [plan, indexPath, setUndo, clearStagedMoves, refreshData, enqueue, stagedMoves, closeReview]);

  if (review !== "relocate") return null;

  return (
    <OverlayShell
      title="Review before moving"
      meta={plan ? `${plan.total_files} files · ${formatBytes(plan.total_bytes)}` : null}
      onClose={closeReview}
      locked={busy}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-105 text-faint">
            Nothing is deleted — files are moved, and Undo puts them back.
          </p>
          <div className="flex gap-1.5">
            <Button onClick={closeReview}>Cancel</Button>
            <Button
              variant="primary"
              icon={ArrowRight}
              disabled={busy || !plan || plan.total_files === 0 || scanView.status === "scanning"}
              onClick={() => void execute()}
            >
              {busy ? "Moving…" : scanView.status === "scanning" ? "Scan running" : "Move files"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        {loading ? (
          <>
            {[0, 1, 2].map((n) => (
              <div key={n} className="h-8 animate-pulse rounded-[7px] bg-inset" />
            ))}
          </>
        ) : error ? (
          <p className="text-125 text-danger">{error}</p>
        ) : plan ? (
          <>
            <SectionLabel>
              {plan.total_files} file{plan.total_files === 1 ? "" : "s"} ·{" "}
              {formatBytes(plan.total_bytes)}
            </SectionLabel>
            <ul className="flex flex-col gap-1">
              {plan.items.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-115">
                  <span className="min-w-0 flex-1 truncate text-dim" title={item.from_path}>
                    {item.from_path}
                  </span>
                  <ArrowRight size={11} className="flex-none text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-ink" title={item.to_path}>
                    {item.to_path}
                  </span>
                  <span className="mono flex-none text-105 text-faint">
                    {formatBytes(item.size)}
                  </span>
                </li>
              ))}
            </ul>

            {plan.dropped.length ? (
              <div className="rounded-[7px] border border-warn-edge bg-warn-wash p-2.5">
                <p className="flex items-center gap-1.5 text-115 text-warn-ink">
                  <AlertTriangle size={12} aria-hidden />
                  {plan.dropped.length} file{plan.dropped.length === 1 ? "" : "s"} dropped since you
                  staged {plan.dropped.length === 1 ? "it" : "them"}
                </p>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {plan.dropped.map((d) => (
                    <li key={d.path} className="truncate text-105 text-dim" title={d.path}>
                      {d.path} — {d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {failures.length ? (
              <div className="rounded-[7px] border border-danger-edge bg-danger-wash p-2.5">
                <p className="text-115 text-danger">
                  {failures.length} file{failures.length === 1 ? "" : "s"} could not be moved
                </p>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {failures.map((f) => (
                    <li key={f.path} className="truncate text-105 text-dim" title={f.path}>
                      {f.path} — {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </OverlayShell>
  );
}
```

> `OverlayShell` takes `title`, `meta`, `onClose`, `width`, `locked`, `children`, `footer` — the action row goes in the `footer` prop, not in `children`. `locked` prevents a backdrop-click close mid-move.

> Executing is blocked while a scan runs: `move_files`' index bookkeeping is best-effort and `mark_missing_files_deleted` only touches rows older than the scan's start, so a mid-scan relocation can leave ghost rows no scan heals.

Mount it next to `ReviewModal` in `workspace/src/components/WorkspaceShell.tsx`:

```tsx
      <RelocateReviewModal />
```

- [ ] **Step 2: Teach UndoToast the relocate shape**

In `workspace/src/components/UndoToast.tsx`, branch on `undo.kind`. `restoreCleanupEntry` does not apply to moved files:

```tsx
  if (undo.kind === "relocate") {
    const undoMove = async () => {
      await moveFiles(reversePairs(undo.pairs), indexPath);
      setUndo(null);
      await refreshData();
    };
    return (
      <ToastShell
        message={`Moved ${undo.pairs.length} file${undo.pairs.length === 1 ? "" : "s"}`}
        actionLabel="Undo"
        onAction={() => void undoMove()}
        onDismiss={() => setUndo(null)}
      />
    );
  }
```

> Match `UndoToast`'s existing markup rather than introducing a `ToastShell` if none exists — the point is the branch and the `moveFiles(reversePairs(...))` call, not new structure.

- [ ] **Step 3: Verify the flow end to end in the browser**

Run: `npm run dev`. Accept a Catalog card → "Review & move" → the from → to listing appears → Move files → the toast offers Undo.

Then set `mockRelocationFails = true` in the console and repeat. Expected: the failure block renders and the modal stays open.

Stage more than three files. Expected: the "dropped" warning block renders.

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workspace/src/components && git commit -m "feat(catalog): add the relocate review gate and undo by reversed pairs"
```

---

### Task 7: Navigation wiring

**Files:**
- Modify: `workspace/src/lib/viewRegistry.ts`, `workspace/src/lib/intent.ts`, `workspace/src/lib/intent.test.ts`, `workspace/src/components/CommandSpine.tsx`, `workspace/src/components/views/OverviewView.tsx`, `workspace/src/components/MiscOverlay.tsx`

**Interfaces:**
- Consumes: `"catalog"` in `StageView` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `workspace/src/lib/intent.test.ts`:

```ts
  it("routes organizing words to the catalog view", () => {
    for (const text of ["catalog", "organize", "tidy", "sort", "misplaced", "arrange"]) {
      expect(parseIntent(text, [])).toEqual({ kind: "stage", view: "catalog" });
    }
  });

  it("does not hijack a filename that merely contains an organizing word", () => {
    expect(parseIntent("sorted-report.pdf", [])).toEqual({ kind: "search", text: "sorted-report.pdf" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/intent.test.ts`
Expected: FAIL — the first case returns a `search` intent.

- [ ] **Step 3: Write the implementation**

In `workspace/src/lib/intent.ts`, add to `STAGE_TRIGGERS` (before the broad `files` entry):

```ts
  { view: "catalog", words: ["catalog", "organize", "tidy", "sort", "misplaced", "arrange"] },
```

In `workspace/src/lib/viewRegistry.ts`, import `FolderTree` and append the entry:

```ts
  { view: "catalog", label: "Catalog", icon: FolderTree, key: "8" },
```

In `workspace/src/components/CommandSpine.tsx`, split the badge so a relocation card never inflates the Board's count — Board renders only `derivedFrom-pattern` and `backupOf-pair`:

```tsx
  const boardBadge = (ontology?.pending_findings ?? 0) + pinned.length;
  const catalogBadge = ontology?.pending_relocations ?? 0;
```
```tsx
              {item.view === "catalog" && catalogBadge > 0 && !active ? (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
              ) : null}
```

> This needs `ontology_status` to expose the split counts. Add `pending_findings` and `pending_relocations` to `OntologyStatusDto` in `src/native/api.rs`, populated by `count_pending` minus `count_pending_by_kind("relocation")` and `count_pending_by_kind("relocation")` respectively (Plan 1, Task 3 provides both). Mirror them in the TS `NativeOntologyStatus` type and the `ontology_status` mock case. If `pending_discoveries` must stay for compatibility, keep it and add the two new fields alongside.

In `workspace/src/components/views/OverviewView.tsx`, add a Catalog tile to the quick-actions grid beside the existing four — a brand-new noun has no muscle memory:

```tsx
        <QuickAction
          icon={FolderTree}
          label="Catalog"
          hint="Files that belong elsewhere"
          onClick={() => setView("catalog")}
        />
```

In `workspace/src/components/MiscOverlay.tsx`, rename the "Cleanup" shortcut section to "Staging" and add a "Review & move" row. `MiscOverlay` derives the view shortcuts from `STAGE_VIEWS`, so key 8 appears automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/intent.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workspace/src && git commit -m "feat(catalog): wire Catalog into the switcher, command line, and overview"
```

---

### Task 8: Files view — multi-select and bulk move

**Files:**
- Modify: `workspace/src/components/views/FilesView.tsx`, `workspace/src/components/MoveDialog.tsx`

**Interfaces:**
- Consumes: `saveCatalogRule`, existing `MoveDialog`.

- [ ] **Step 1: Add multi-select to FilesView**

Local state only — mirror `CleanupView`'s `picked`, not a store global. The row body keeps driving the Inspector; the checkbox is a separate hit target.

```tsx
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const togglePick = useCallback((path: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // "All loaded", never "all matching": search_files has no OFFSET and returns
  // no total, so the frontend only ever holds the first SEARCH_LIMIT rows.
  const pickAllLoaded = useCallback(() => {
    setPicked(new Set(rows.map((r) => r.path)));
  }, [rows]);
```

Render a bulk bar above the list when `picked.size > 0`:

```tsx
      {picked.size ? (
        <div className="flex flex-none items-center gap-2 border-b border-line bg-inset px-3 py-2">
          <span className="text-115 text-ink">{picked.size} selected</span>
          <button type="button" onClick={pickAllLoaded} className="text-115 text-primary-ink hover:underline">
            Select all {rows.length} loaded
          </button>
          <button type="button" onClick={() => setPicked(new Set())} className="text-115 text-faint hover:text-ink">
            Clear
          </button>
          <span className="flex-1" />
          <Button variant="primary" icon={FolderInput} onClick={() => setMoveOpen(true)}>
            Move to…
          </Button>
        </div>
      ) : null}
```

Fix the count line, which today reports `rows.length` and so silently under-reports past the limit:

```tsx
          {rows.length >= SEARCH_LIMIT
            ? `showing first ${SEARCH_LIMIT} matches`
            : `${rows.length} match${rows.length === 1 ? "" : "es"}`}
```

Add a checkbox cell to each row, stopping propagation so it does not also select for the Inspector:

```tsx
                    <input
                      type="checkbox"
                      checked={picked.has(r.path)}
                      aria-label={`Select ${r.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => togglePick(r.path)}
                      className="flex-none"
                    />
```

Mount the dialog, and offer to save a rule when the selection came from a filter query:

```tsx
      {moveOpen ? (
        <MoveDialog
          paths={[...picked]}
          onClose={() => setMoveOpen(false)}
          onMoved={(destination) => {
            setPicked(new Set());
            if (resultsQuery?.kind === "search" && destination && indexPath) {
              setRulePrompt({ text: resultsQuery.text, destination });
            }
          }}
        />
      ) : null}

      {rulePrompt ? (
        <div className="flex flex-none items-center gap-2 border-t border-line bg-inset px-3 py-2">
          <span className="text-115 text-dim">
            Always move files matching “{rulePrompt.text}” to {rulePrompt.destination}?
          </span>
          <Button
            onClick={() => {
              if (indexPath) {
                void saveCatalogRule(indexPath, {
                  name: `Files matching “${rulePrompt.text}”`,
                  nameContains: rulePrompt.text,
                  destination: rulePrompt.destination,
                  source: "saved-after-move",
                });
              }
              setRulePrompt(null);
            }}
          >
            Save as rule
          </Button>
          <button type="button" onClick={() => setRulePrompt(null)} className="text-115 text-faint hover:text-ink">
            No thanks
          </button>
        </div>
      ) : null}
```

- [ ] **Step 2: Add the create-folder input to MoveDialog**

`move_files` already `create_dir_all`s the destination parent, so this is **frontend only**. The destination field stays `readOnly` in native mode; the new input is a separate optional subfolder name.

Add state and the field:

```tsx
  const [subfolder, setSubfolder] = useState("");
```
```tsx
        <label className="mt-2 flex flex-col gap-1">
          <span className="text-105 text-faint">New subfolder (optional)</span>
          <input
            value={subfolder}
            onChange={(e) => setSubfolder(e.target.value)}
            placeholder="e.g. Invoices"
            spellCheck={false}
            className="rounded-[7px] border border-line-input bg-field px-2.5 py-1.5 text-115 text-ink outline-none"
          />
        </label>
```

Fold it into the destination at confirm time, reusing the existing `joinDest` helper:

```tsx
  const target = subfolder.trim() ? joinDest(dest, subfolder.trim()) : dest;
```

Use `target` everywhere `dest` was previously used to build each file's destination, and pass it to `onMoved` so the caller can offer the rule.

Change the prop type:

```tsx
  /** Fired once every file landed in the destination (just before the dialog closes). */
  onMoved: (destination: string) => void;
```

> `Inspector.tsx:362` and `DuplicatesView.tsx:366` also pass `onMoved` — update both call sites to accept (and ignore) the argument.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`. Search in Files, tick several rows, "Select all N loaded", **Move to…**, type a subfolder, confirm. Expected: the rule prompt appears for a search-derived selection.

- [ ] **Step 4: Commit**

```bash
git add workspace/src/components && git commit -m "feat(files): multi-select, bulk move with new subfolder, and save-as-rule"
```

---

### Task 9: Docs and the full gate

**Files:**
- Modify: `README.md:37-43`, `docs/guide/` (the view reference page)

- [ ] **Step 1: Add Catalog to the README view table**

```markdown
| **Catalog** | Grouped "these files belong somewhere else" suggestions — learned from where you already keep things, reviewed before anything moves. |
```

- [ ] **Step 2: Update the docs site view reference**

Add the same row to the corresponding table under `docs/guide/`. Do **not** add plan or spec files to `docs/` — that directory is the published MkDocs site.

- [ ] **Step 3: Run every gate**

From the repo root:

```bash
cargo test
```
Expected: PASS.

```bash
cargo check --manifest-path src-tauri\Cargo.toml
```
Expected: `Finished`.

From `workspace/`:

```bash
npx tsc --noEmit
```
Expected: no output.

```bash
npx vitest run
```
Expected: PASS — including `catalog.test.ts`, `undo.test.ts`, and `intent.test.ts`.

```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add README.md docs && git commit -m "docs(catalog): document the Catalog view"
```

---

## Self-Review

**Spec coverage.** Separate `stagedMoves` + review discriminant + undo union → Task 1. Bridge + mocks → Task 2. Ranking/parsing → Task 3. Catalog view with the `ontology === null` startup guard, lazy members, per-file exclude → Task 4. Dual-kind tray → Task 5. `RelocateReviewModal` with dropped/failure blocks and scan gating, undo by reversed pairs → Task 6. Nav wiring including the badge split, intent triggers, Overview tile → Task 7. Files multi-select with the honest 500 cap, MoveDialog subfolder, save-as-rule → Task 8. Docs + gates → Task 9.

**Type consistency.** `StagedMove` fields (`path`, `name`, `bytes`, `to`, `destinationExists`, `fileId`, `discoveryId`) are produced in Task 4's `accept` and consumed in Task 6's `buildRelocationPlan` mapping — the snake_case conversion happens exactly once, at the bridge. `UndoState` is widened in Task 1 and both branches are handled in Task 6.

**Known cross-plan dependency.** Task 7's badge split needs `pending_findings` / `pending_relocations` on `OntologyStatusDto`, which Plan 1 does not add. If Plan 1 has already shipped, that is a small follow-on change to `src/native/api.rs` plus its mock; the note in Task 7 spells it out. Everything else in this plan depends only on commands Plan 1 delivers.

**Deliberately not done.** No component tests — the repo has none and `@testing-library` is unused; behaviour is covered by pure-function tests plus browser verification against the mock backend. No persistent "Recently arranged" log. No Inspector hints or Overview headline chip.
