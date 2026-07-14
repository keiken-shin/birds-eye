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
};

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
export type NativeMoveResult = { moved: number; failed: NativeMoveFailure[] };

/** Move files to a new folder (rename, or copy+remove across volumes). */
export async function moveFiles(
  moves: Array<{ from: string; to: string }>,
  indexPath?: string | null
) {
  return invoke<NativeMoveResult>("move_files", {
    request: { moves, index_path: indexPath ?? null },
  });
}

// ---- Ontology: cleanup ----

export type NativeCleanupCandidate = {
  file_id: number;
  entity_id: number;
  path: string;
  size: number;
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
  scope: { reasons?: string[]; maxSize?: number | null; pathPrefix?: string | null }
) {
  return invoke<NativeCleanupPlan>("cleanup_plan", {
    request: {
      index_path: indexPath,
      reasons: scope.reasons ?? [],
      max_size: scope.maxSize ?? null,
      path_prefix: scope.pathPrefix ?? null,
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
  pending_discoveries: number;
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
};

export async function treemapLensData(indexPath: string) {
  return invoke<NativeTreemapLensFolder[]>("treemap_lens_data", {
    request: { index_path: indexPath },
  });
}

// ---- Shared display constants ----

export const REASON_LABELS: Record<string, string> = {
  "safe-derivative": "Safe derivative",
  "redundant-backup": "Redundant backup",
  scratch: "Scratch / cache",
  "finished-project-cruft": "Finished-project cruft",
};

export const DISCOVERY_KIND_LABELS: Record<string, string> = {
  "derivedFrom-pattern": "Derived-from suggestions",
  "backupOf-pair": "Backup-of suggestions",
};
