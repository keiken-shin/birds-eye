import { useEffect, useState } from "react";
import { searchNativeIndex, type NativeSearchResult } from "../nativeClient";
import { type ScanState } from "../domain";
import { mediaKindFromCategory } from "../utils/scanUtils";

export function useSearch({
  currentIndexPath,
  nativeRuntime,
  largestFiles,
  setRuntimeMessage,
}: {
  currentIndexPath: string | null;
  nativeRuntime: boolean;
  largestFiles: ScanState["largestFiles"];
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
}): {
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchResults: NativeSearchResult[];
} {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NativeSearchResult[]>([]);

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    if (!nativeRuntime || !currentIndexPath) {
      const browserMatches = largestFiles
        .filter((file) => file.path.toLowerCase().includes(trimmedQuery.toLowerCase()))
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
      void searchNativeIndex(currentIndexPath, trimmedQuery, 24)
        .then(setSearchResults)
        .catch((error) => {
          setRuntimeMessage(error instanceof Error ? error.message : "Search failed");
          setSearchResults([]);
        });
    }, 180);

    return () => window.clearTimeout(handle);
  }, [currentIndexPath, nativeRuntime, largestFiles, searchQuery, setRuntimeMessage]);

  return { searchQuery, setSearchQuery, searchResults };
}
