import { useEffect, useRef, useState } from "react";
import { searchNativeIndex, type NativeSearchResult } from "../nativeClient";
import { type ScanState, type SearchFilters } from "../domain";
import { mediaKindFromCategory } from "../utils/scanUtils";

export function useSearch({
  currentIndexPath,
  nativeRuntime,
  largestFiles,
  setRuntimeMessage,
  filters,
}: {
  currentIndexPath: string | null;
  nativeRuntime: boolean;
  largestFiles: ScanState["largestFiles"];
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
  filters?: SearchFilters;
}): {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchResults: NativeSearchResult[];
} {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NativeSearchResult[]>([]);
  // Use refs for unstable callback/object props to avoid infinite re-render loops when
  // callers pass new references on each render (e.g. inline arrow functions or object literals).
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const filtersKey = JSON.stringify(filters);
  const setRuntimeMessageRef = useRef(setRuntimeMessage);
  setRuntimeMessageRef.current = setRuntimeMessage;

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    if (!nativeRuntime || !currentIndexPath) {
      const f = filtersRef.current;
      const browserMatches = largestFiles
        .filter((file) => {
          if (!file.path.toLowerCase().includes(trimmedQuery.toLowerCase())) return false;
          if (f?.kinds?.length && !f.kinds.includes(file.category)) return false;
          if (f?.extensions?.length && !f.extensions.some((ext) => file.extension?.toLowerCase() === ext.toLowerCase())) return false;
          if (f?.minBytes !== undefined && file.bytes < f.minBytes) return false;
          if (f?.maxBytes !== undefined && file.bytes > f.maxBytes) return false;
          return true;
        })
        .slice(0, 24)
        .map((file) => ({
          path: file.path,
          name: file.name,
          size: file.bytes,
          extension: file.extension,
          media_kind: mediaKindFromCategory(file.category),
          modified_at: file.modified || null,
        }));
      setSearchResults(browserMatches);
      return;
    }

    const handle = window.setTimeout(() => {
      const f = filtersRef.current;
      // CategoryKey values must be mapped to native media_kind strings expected by the Rust backend
      const nativeFilters = f
        ? { ...f, kinds: f.kinds?.map(mediaKindFromCategory) }
        : undefined;
      void searchNativeIndex(currentIndexPath, trimmedQuery, 24, nativeFilters)
        .then(setSearchResults)
        .catch((error) => {
          setRuntimeMessageRef.current(error instanceof Error ? error.message : "Search failed");
          setSearchResults([]);
        });
    }, 180);

    return () => window.clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndexPath, nativeRuntime, largestFiles, searchQuery, filtersKey]);

  return { searchQuery, setSearchQuery, searchResults };
}
