import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type NativeJobStatus = "Running" | "Completed" | "Cancelled" | "Failed";

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
};

export type NativeIndexOverview = {
  folders: Array<{ path: string; total_files: number; total_bytes: number }>;
  files: Array<{ path: string; size: number; extension: string | null; media_kind: string }>;
  extensions: Array<{ extension: string; file_count: number; total_bytes: number }>;
  duplicate_groups: Array<{
    id: number;
    size: number;
    file_count: number;
    reclaimable_bytes: number;
    confidence: number;
  }>;
  media: Array<{ media_kind: string; file_count: number; total_bytes: number }>;
  folder_media: Array<{ folder_path: string; media_kind: string; total_bytes: number }>;
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
};

export type NativeDuplicateFile = {
  path: string;
  size: number;
  modified_at: number | null;
};

export async function isNativeRuntime() {
  return isTauri();
}

export async function chooseNativeFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a folder to index",
  });

  return typeof selected === "string" ? selected : null;
}

export async function startNativeScan(root: string) {
  const response = await invoke<{ job_id: number; index_path: string }>("start_scan_job_for_root", {
    root,
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

export async function queryNativeIndex(indexPath: string, limit: number) {
  return invoke<NativeIndexOverview>("query_index", {
    request: {
      index_path: indexPath,
      limit,
    },
  });
}

export async function searchNativeIndex(indexPath: string, query: string, limit: number) {
  return invoke<NativeSearchResult[]>("search_files", {
    request: {
      index_path: indexPath,
      query,
      limit,
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

export async function listNativeIndexes() {
  return invoke<NativeIndexEntry[]>("list_indexes");
}

export async function deleteNativeIndex(indexPath: string) {
  await invoke("delete_index", { indexPath });
}
