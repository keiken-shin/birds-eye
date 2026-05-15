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
