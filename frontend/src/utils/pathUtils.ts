export function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function parentPath(path: string): string | null {
  const normalized = normalizePath(path);
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : null;
}

export function isDescendantPath(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  if (normalizedPath === normalizedParent) return false;
  return normalizedPath.startsWith(`${normalizedParent}\\`) || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function truncatePath(path: string, keepSegments = 2): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const isWin = parts[0]?.endsWith(":");
  const rootCount = isWin ? 1 : 0;

  if (parts.length <= rootCount + keepSegments) return path;

  const root = isWin ? `${parts[0]}${sep}` : sep;
  const tail = parts.slice(-keepSegments).join(sep);
  return `${root}...${sep}${tail}`;
}
