import { convertFileSrc, invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ScanStrategy } from "./domain";
import { mockInvoke, mockListen, mockPreviewSrc } from "../dev/mockBackend";

/**
 * Outside the Tauri shell (plain `vite` in a browser) every command routes to
 * the in-memory mock backend so the whole workspace stays designable and
 * testable. Inside Tauri this resolves to the real IPC at module load.
 */
const native = isTauri();
const invoke: typeof tauriInvoke = native ? tauriInvoke : (mockInvoke as typeof tauriInvoke);
const listen: typeof tauriListen = native ? tauriListen : (mockListen as typeof tauriListen);

export type NativeJobStatus = "Running" | "Completed" | "Cancelled" | "Failed";

export type NativeLogLine = {
  phase: string;
  message: string;
  elapsed_ms: number;
};

export type NativePhaseTimingEntry = {
  phase: string;
  duration_ms: number;
};

export type NativeJobEvent = {
  job_id: number;
  status: NativeJobStatus;
  message: string;
  files_scanned: number;
  folders_scanned: number;
  bytes_scanned: number;
  queue_depth: number;
  active_workers: number;
  current_path: string | null;
  progress_current: number;
  progress_total: number;
  log_line?: NativeLogLine;
  phase_timings?: NativePhaseTimingEntry[];
};

export type NativeOverviewFile = {
  path: string;
  size: number;
  extension: string | null;
  media_kind: string;
  modified_at: number | null;
  file_id: number;
};

/** One month of modified-time activity (`bucket` = `YYYY-MM`). */
export type NativeTimelineBucket = { bucket: string; file_count: number; total_bytes: number };

/** Staleness band: lt1mo · 1to3mo · 3to6mo · 6to12mo · 1to2yr · gt2yr · unknown. */
export type NativeAgeBucket = { bucket: string; file_count: number; total_bytes: number };

export type NativeIndexOverview = {
  folders: Array<{ path: string; total_files: number; total_bytes: number }>;
  files: NativeOverviewFile[];
  extensions: Array<{ extension: string; file_count: number; total_bytes: number }>;
  duplicate_groups: Array<{
    id: number;
    size: number;
    file_count: number;
    reclaimable_bytes: number;
    confidence: number;
    /** up to 8 member paths, largest first — relates groups to folders/findings */
    sample_paths: string[];
  }>;
  media: Array<{ media_kind: string; file_count: number; total_bytes: number }>;
  folder_media: Array<{ folder_path: string; media_kind: string; total_bytes: number }>;
  timeline: NativeTimelineBucket[];
  age_buckets: NativeAgeBucket[];
};

export type NativeSearchResult = {
  path: string;
  name: string;
  size: number;
  extension: string | null;
  media_kind: string;
  modified_at: number | null;
  file_id: number;
};

export type NativeIndexEntry = {
  index_path: string;
  root_path: string | null;
  last_status: string | null;
  last_scanned_at: number | null;
  files_scanned: number;
  folders_scanned: number;
  bytes_scanned: number;
  scan_strategy: ScanStrategy;
  /** entries the walk couldn't read (permissions/locked) — not indexed */
  walk_issues: number;
  /** files whose content couldn't be hashed — excluded from duplicate detection */
  hash_issues: number;
  /** whether the intelligence (ontology) layer is enabled for this index */
  intelligence: boolean;
};

export type NativeScanIssue = {
  /** 'walk' — couldn't be indexed · 'hash' — couldn't be content-verified */
  phase: "walk" | "hash";
  path: string;
  message: string;
};

export type NativeDuplicateFile = {
  path: string;
  size: number;
  modified_at: number | null;
  hash_state: 0 | 2 | 4;
  file_id: number;
};

/**
 * One fixed drive, as the first-run picker lists it.
 *
 * Capacity is nullable on purpose (`Option<u64>` in `src/native/drives.rs`): an
 * unformatted, BitLocker-locked or empty-card-reader volume still enumerates as
 * a fixed drive but can't report its size. Such a drive stays in the list with
 * its capacity shown as unknown — never dropped, never rendered as 0 B.
 */
export type NativeDriveInfo = {
  root_path: string;
  volume_label: string | null;
  total_bytes: number | null;
  free_bytes: number | null;
  drive_type: string;
};

/** The machine's fixed drives — the first thing the scan sheet shows. */
export async function listFixedDrives() {
  return invoke<NativeDriveInfo[]>("list_fixed_drives");
}

export async function isNativeRuntime() {
  return isTauri();
}

export async function chooseNativeFolder() {
  if (!native) return "C:\\Users\\alex";
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a folder to index",
  });

  return typeof selected === "string" ? selected : null;
}

export async function startNativeScan(
  root: string,
  scanStrategy: ScanStrategy,
  enableIntelligence?: boolean
) {
  const response = await invoke<{ job_id: number; index_path: string }>("start_scan_job_for_root", {
    root,
    scanStrategy,
    // undefined leaves the index's existing intelligence setting untouched.
    enableIntelligence: enableIntelligence ?? null,
  });

  return { jobId: response.job_id, indexPath: response.index_path };
}

export async function cancelNativeScan(jobId: number) {
  await invoke("cancel_scan_job", { jobId });
}

export async function nativeJobEvents(jobId: number, offset: number) {
  return invoke<NativeJobEvent[]>("scan_job_events", { jobId, offset });
}

export async function nativeJobStatus(jobId: number) {
  return invoke<NativeJobStatus>("scan_job_status", { jobId });
}

export async function listenNativeJobEvents(callback: (event: NativeJobEvent) => void) {
  return listen<NativeJobEvent>("scan-job-event", (event) => callback(event.payload));
}

export async function queryNativeIndex(indexPath: string, limit: number) {
  return invoke<NativeIndexOverview>("query_index", {
    request: {
      index_path: indexPath,
      limit,
    },
  });
}

export type NativeScanCoverage = {
  files_indexed: number;
  read_fully: number;
  read_sampled: number;
  not_needed: number;
  skipped_offline: number;
  skipped_locked: number;
  skipped_denied: number;
  skipped_changed: number;
  skipped_failed: number;
  folders_unreadable: number;
};

/** What the last scan actually managed to read — so a recommendation can say
 *  what it rests on, rather than implying it saw everything. */
export async function scanCoverage(indexPath: string) {
  return invoke<NativeScanCoverage>("scan_coverage", {
    request: { index_path: indexPath },
  });
}

/** Files and folders the last scan couldn't read (walk) or verify (hash). */
export async function scanIssues(indexPath: string, limit = 500) {
  return invoke<NativeScanIssue[]>("scan_issues", {
    request: {
      index_path: indexPath,
      limit,
    },
  });
}

/** Targeted retry: re-walks failed directories and re-verifies unhashed files
 *  only — no full rescan. Resolves to the counts still failing afterwards. */
export async function retryScanIssues(indexPath: string) {
  return invoke<{ walk_issues: number; hash_issues: number }>("retry_scan_issues", {
    request: {
      index_path: indexPath,
    },
  });
}

/** Names of processes currently holding the file open (Windows Restart Manager). */
export async function fileLockHolders(path: string) {
  return invoke<string[]>("file_lock_holders", {
    request: {
      path,
    },
  });
}

/** Direct children of one folder (largest first) — drill-down past the
 *  overview's global top-N folder list. */
export async function folderChildren(indexPath: string, parentPath: string, limit = 500) {
  return invoke<Array<{ path: string; total_files: number; total_bytes: number }>>(
    "folder_children",
    {
      request: {
        index_path: indexPath,
        parent_path: parentPath,
        limit,
      },
    }
  );
}

export async function searchNativeIndex(
  indexPath: string,
  query: string,
  limit: number,
  filters?: {
    kinds?: string[];
    extensions?: string[];
    minBytes?: number;
    maxBytes?: number;
    useRegex?: boolean;
  }
) {
  return invoke<NativeSearchResult[]>("search_files", {
    request: {
      index_path: indexPath,
      query,
      limit,
      kinds: filters?.kinds ?? null,
      extensions: filters?.extensions ?? null,
      min_bytes: filters?.minBytes ?? null,
      max_bytes: filters?.maxBytes ?? null,
      use_regex: filters?.useRegex ?? null,
    },
  });
}

export async function queryNativeDuplicateFiles(indexPath: string, groupId: number, limit: number) {
  return invoke<NativeDuplicateFile[]>("duplicate_group_files", {
    request: {
      index_path: indexPath,
      group_id: groupId,
      limit,
    },
  });
}

/**
 * Allow the asset protocol to serve this index's scan root for media preview.
 * The backend validates the index lives in the app dir and derives the root
 * itself. Returns the allowed root path.
 */
export async function allowPreviewRoot(indexPath: string) {
  return invoke<string>("allow_preview_root", { indexPath });
}

/** Webview-loadable URL for a local file (valid only under a root allowed above). */
export function previewSrc(path: string) {
  return native ? convertFileSrc(path) : mockPreviewSrc(path);
}

export async function listNativeIndexes() {
  return invoke<NativeIndexEntry[]>("list_indexes");
}

export async function deleteNativeIndex(indexPath: string) {
  await invoke("delete_index", { indexPath });
}

export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}

export type NativeTrashFailure = { path: string; reason: string };

/**
 * User-override removal to the recycle bin, bypassing the cleanup predicate.
 * Only called from the Review gate's explicit consent flow — never silently.
 */
export async function trashFiles(paths: string[], indexPath?: string | null) {
  return invoke<{ failed: NativeTrashFailure[] }>("trash_files", {
    request: { paths, index_path: indexPath ?? null },
  });
}

export type NativeMoveFailure = { path: string; reason: string };

// ---- Ontology: cleanup ----

export type NativeCleanupCandidate = {
  file_id: number;
  entity_id: number;
  path: string;
  size: number;
  /** Unix seconds from `files.modified_at`. Null when the scanner never
   *  recorded one — the row says so rather than showing an invented age. */
  modified_at: number | null;
  reason: string;
};

export type NativeCleanupPlan = {
  plan_id: number;
  total_files: number;
  total_bytes: number;
  candidates: NativeCleanupCandidate[];
};

export type NativeCleanupResult = {
  plan_id: number;
  cleaned: number;
  bytes_cleaned: number;
  failed: Array<{ file_id: number; path: string; reason: string }>;
};

export type NativeCleanupLogEntry = {
  id: number;
  cleanup_plan_id: number;
  file_id: number;
  original_path: string;
  size: number;
  cleaned_at: number;
  reason: string;
  restore_status: "pending" | "in_recycle_bin" | "restored" | "expired";
  expires_at: number | null;
};

export async function buildCleanupPlan(
  indexPath: string,
  scope: {
    reasons?: string[];
    maxSize?: number | null;
    pathPrefix?: string | null;
    /**
     * The exact rows the person reviewed. Recorded on the plan, and intersected
     * with the live predicate at execute time — so the plan can only ever act on
     * fewer files than were reviewed, never on different ones.
     */
    fileIds?: number[] | null;
  }
) {
  return invoke<NativeCleanupPlan>("cleanup_plan", {
    request: {
      index_path: indexPath,
      reasons: scope.reasons ?? [],
      max_size: scope.maxSize ?? null,
      path_prefix: scope.pathPrefix ?? null,
      file_ids: scope.fileIds ?? null,
    },
  });
}

export async function executeCleanupPlan(
  indexPath: string,
  planId: number,
  retentionDays?: number
) {
  return invoke<NativeCleanupResult>("execute_cleanup_plan", {
    request: { index_path: indexPath, plan_id: planId, retention_days: retentionDays ?? null },
  });
}

export async function recentlyCleaned(indexPath: string, limit: number, offset = 0) {
  return invoke<NativeCleanupLogEntry[]>("recently_cleaned", {
    request: { index_path: indexPath, limit, offset },
  });
}

export async function restoreCleanupEntry(indexPath: string, entryId: number) {
  await invoke("restore_from_cleanup_log", { request: { index_path: indexPath, entry_id: entryId } });
}

export async function pinFile(indexPath: string, fileId: number, note?: string) {
  await invoke("pin_file", { request: { index_path: indexPath, file_id: fileId, note: note ?? null } });
}

export async function unpinFile(indexPath: string, fileId: number) {
  await invoke("unpin_file", { request: { index_path: indexPath, file_id: fileId } });
}

// ---- Ontology: discoveries ----

export type NativeDiscovery = {
  id: number;
  kind: string;
  payload: string;
  status: "Pending" | "Confirmed" | "Rejected" | "Expired";
  confidence: number;
  potential_bytes_unlocked: number;
  created_at: number;
  resolved_at: number | null;
};

export async function listDiscoveries(indexPath: string, kind: string, limit: number) {
  return invoke<NativeDiscovery[]>("discoveries", { request: { index_path: indexPath, kind, limit } });
}

export async function confirmDiscovery(indexPath: string, id: number) {
  await invoke("confirm_discovery", { request: { index_path: indexPath, id, reason: null } });
}

export async function rejectDiscovery(indexPath: string, id: number, reason?: string) {
  await invoke("reject_discovery", { request: { index_path: indexPath, id, reason: reason ?? null } });
}

export async function confirmDiscoveryPattern(indexPath: string, kind: string) {
  return invoke<number>("confirm_discovery_pattern", { request: { index_path: indexPath, kind, reason: null } });
}

export async function rejectDiscoveryPattern(indexPath: string, kind: string, reason?: string) {
  return invoke<number>("reject_discovery_pattern", {
    request: { index_path: indexPath, kind, reason: reason ?? null },
  });
}

// ---- Ontology: saved views ----

export type NativeSavedView = { id: string; name: string; description: string; protective: boolean };
export type NativeSavedViewRow = { file_id: number; path: string; size: number };

export async function listSavedViews() {
  return invoke<NativeSavedView[]>("saved_views");
}

export async function runSavedView(
  indexPath: string,
  viewId: string,
  params?: { days?: number; minBytes?: number }
) {
  return invoke<NativeSavedViewRow[]>("run_saved_view", {
    request: {
      index_path: indexPath,
      view_id: viewId,
      days: params?.days ?? null,
      min_bytes: params?.minBytes ?? null,
    },
  });
}

// ---- Ontology: provenance + override + toggle ----

export type NativeFileProvenance = {
  file_id: number;
  path: string;
  is_pinned: boolean;
  attrs: Array<{ key: string; value: string; source: string; confidence: number }>;
  relations: Array<{ predicate: string; object_path: string | null; source: string; confidence: number }>;
};

export async function fileProvenance(indexPath: string, fileId: number) {
  return invoke<NativeFileProvenance>("file_provenance", { request: { index_path: indexPath, file_id: fileId } });
}

export async function overrideClassification(indexPath: string, fileId: number, key: string, value: string) {
  await invoke("override_classification", { request: { index_path: indexPath, file_id: fileId, key, value } });
}

export type NativePopulatorState = {
  name: string;
  status: "idle" | "running" | "paused" | "completed" | "failed";
  files_visited: number;
  discoveries_emitted: number;
  last_error: string | null;
};

export type NativeOntologyStatus = {
  enabled: boolean;
  pending_findings: number;
  pending_relocations: number;
  total_files: number;
  populators: NativePopulatorState[];
};

export async function ontologyStatus(indexPath: string) {
  return invoke<NativeOntologyStatus>("ontology_status", { request: { index_path: indexPath } });
}

export async function setOntologyEnabled(indexPath: string, enabled: boolean) {
  await invoke("set_ontology_enabled", { request: { index_path: indexPath, enabled } });
}

export type NativeEnrichmentBudget = "cheap-only" | "standard" | "all-opt-in";

export async function runOntologyEnrichment(indexPath: string, budget: NativeEnrichmentBudget) {
  return invoke<{ ran: boolean }>("run_ontology_enrichment", {
    request: { index_path: indexPath, budget },
  });
}

// ---- Ontology: treemap lenses ----

export type NativeTreemapLensFolder = {
  folder_path: string;
  role: string | null;
  replaceability: string | null;
  lifecycle: string | null;
  cleanup_reason: string | null;
  reclaimable_bytes: number;
  /** Unix seconds: the newest modified time anywhere in this folder's subtree —
   *  "how long since you touched it" for the recommendation row. Null when
   *  nothing under it carries a timestamp. */
  modified_at: number | null;
};

export async function treemapLensData(indexPath: string) {
  return invoke<NativeTreemapLensFolder[]>("treemap_lens_data", {
    request: { index_path: indexPath },
  });
}

// ---- Ontology: cataloging ----

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
  /** Move-log rows for the files that moved. Undo goes through these. */
  entry_ids: number[];
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

/** One row of the durable move log. `restore_status` is "moved" until it is put back. */
export type NativeRelocationLogEntry = {
  id: number;
  file_id: number | null;
  from_path: string;
  to_path: string;
  size: number;
  moved_at: number;
  modified_at: number | null;
  restore_status: string;
};

/**
 * Moves that can still be put back, newest first. This is the durable half of undo:
 * the toast lives in React state and dies with the window, this survives a restart.
 */
export async function recentlyMoved(indexPath: string, limit = 50, offset = 0) {
  return invoke<NativeRelocationLogEntry[]>("recently_moved", {
    request: { index_path: indexPath, limit, offset },
  });
}

/**
 * Put one logged move back at its original path. The backend refuses rather than
 * guesses — gone, changed, already restored, or something sitting at the original
 * path all come back as an error message written for the person reading it.
 */
export async function restoreMove(indexPath: string, entryId: number) {
  return invoke<void>("restore_from_relocation_log", {
    request: { index_path: indexPath, entry_id: entryId },
  });
}

/** One thing on the staging desk. Durable — it survives closing the app. */
export type NativeStagedItem = {
  id: number;
  kind: "file" | "folder";
  path: string;
  file_id: number | null;
  name: string;
  bytes: number;
  verdict: string | null;
  reason: string | null;
  group_name: string | null;
  note: string | null;
  added_at: number;
};

export async function stageItem(
  indexPath: string,
  item: Omit<NativeStagedItem, "id" | "added_at">
) {
  await invoke("stage_item", { request: { index_path: indexPath, ...item } });
}

export async function unstageItem(indexPath: string, path: string) {
  await invoke("unstage_item", { request: { index_path: indexPath, path } });
}

export async function stagedItems(indexPath: string) {
  return invoke<NativeStagedItem[]>("staged_items", { request: { index_path: indexPath } });
}

export async function setStagedGroup(
  indexPath: string,
  paths: string[],
  groupName: string | null
) {
  await invoke("set_staged_group", {
    request: { index_path: indexPath, paths, group_name: groupName },
  });
}

export async function clearStagedItems(indexPath: string, groupName: string | null = null) {
  await invoke("clear_staged", { request: { index_path: indexPath, group_name: groupName } });
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

// ---- Shared display constants ----

/**
 * The backend's cleanup reasons, said out loud. These render in the review gate — the screen
 * where someone confirms a deletion — so title-casing the enum ("Safe derivative",
 * "Finished-project cruft") put the taxonomy in front of the user at the highest-stakes moment.
 * Written as noun phrases so they read after an em dash too: "Bird's Eye won't remove this — …".
 */
export const REASON_LABELS: Record<string, string> = {
  "safe-derivative": "Something a build made",
  "redundant-backup": "A copy you already have twice",
  scratch: "A build cache",
  "finished-project-cruft": "Left over from a finished project",
};
