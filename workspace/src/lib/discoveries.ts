import type { NativeDiscovery } from "@bridge/nativeClient";

/**
 * Discovery kinds the Board surfaces. Each discovery is a provenance relation *candidate*
 * (same predicate vocabulary as file_provenance relations[]: derivedFrom / backupOf), but
 * carries the two endpoint paths directly in its payload — so the Board draws the edge from
 * the payload, with no file_id needed (folders/discovery paths have none).
 */
export const FINDING_KINDS = ["derivedFrom-pattern", "backupOf-pair"] as const;

export type Finding = {
  id: number;
  kind: string;
  /** the reclaimable endpoint (derivative / backup) — the thing freed if confirmed then cleaned */
  subject: string;
  /** the original it depends on (source / origin) */
  object: string;
  /** human edge label */
  predicate: string;
  confidence: number;
  bytes: number;
  status: NativeDiscovery["status"];
};

/** Parse a backend discovery's JSON payload into a typed finding (one Board card = one edge). */
export function parseFinding(d: NativeDiscovery): Finding | null {
  let subject: string | undefined;
  let object: string | undefined;
  let predicate: string;
  try {
    const p = JSON.parse(d.payload) as Record<string, string>;
    if (d.kind === "derivedFrom-pattern") {
      subject = p.derivative_path;
      object = p.source_path;
      predicate = "derived from";
    } else if (d.kind === "backupOf-pair") {
      subject = p.backup_path;
      object = p.origin_path;
      predicate = "backup of";
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!subject || !object) return null;
  return {
    id: d.id,
    kind: d.kind,
    subject,
    object,
    predicate,
    confidence: d.confidence,
    bytes: d.potential_bytes_unlocked,
    status: d.status,
  };
}

/** Basename for compact chip display (handles / and \\, tolerates a trailing separator). */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
