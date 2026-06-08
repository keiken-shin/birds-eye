import { useMemo, useEffect, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import { MetricGrid } from "../components/MetricGrid";
import { FilterBar } from "../components/FilterBar";
import { AnalysisSection } from "../components/AnalysisSection";
import { FoldersTable } from "../components/FoldersTable";
import { DetailGrid } from "../components/DetailGrid";
import { DuplicatesSection } from "../components/DuplicatesSection";
import { CommandPalette } from "../components/CommandPalette";
import { useDuplicates } from "../hooks/useDuplicates";
import { useAuditQueue } from "../hooks/useAuditQueue";
import { parentPath, isDescendantPath } from "../utils/pathUtils";
import { treemapLensData } from "../nativeClient";
import type { TreemapLens, TreemapLensMap } from "../components/TreemapCanvas";

export function WorkspacePage() {
  const {
    workspaceScan,
    workspaceIndexPath,
    filter,
    setFilter,
    focusedFolder,
    setFocusedFolder,
    nativeRuntime,
    setRuntimeMessage,
    refreshWorkspaceIndex,
  } = useScanContext();

  const {
    duplicateFiles,
    selectedDuplicateGroup,
    comparisonCursor,
    setComparisonCursor,
    selectDuplicateCandidate,
    clearDuplicates,
  } = useDuplicates({ currentIndexPath: workspaceIndexPath, setRuntimeMessage });

  const { staged, stagedBytes, stage, unstage, trashStaged, clearQueue, trashProgress, dismissProgress } =
    useAuditQueue(setRuntimeMessage);
  const [treemapLens, setTreemapLens] = useState<TreemapLens>("size");
  const [treemapLensMap, setTreemapLensMap] = useState<TreemapLensMap>({});

  useEffect(() => {
    if (workspaceIndexPath === null) {
      clearDuplicates();
      clearQueue();
      setTreemapLensMap({});
    }
  }, [workspaceIndexPath, clearDuplicates, clearQueue]);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceIndexPath || !nativeRuntime) {
      setTreemapLensMap({});
      return;
    }

    void treemapLensData(workspaceIndexPath)
      .then((rows) => {
        if (cancelled) return;
        setTreemapLensMap(
          rows.reduce((acc, row) => {
            acc[row.folder_path] = row;
            return acc;
          }, {} as TreemapLensMap)
        );
      })
      .catch((error) => {
        if (!cancelled) setRuntimeMessage(`Treemap ontology lenses unavailable: ${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [nativeRuntime, setRuntimeMessage, workspaceIndexPath]);

  useEffect(() => {
    if (selectedDuplicateGroup !== null && duplicateFiles.length > 0 && duplicateFiles.length < 2) {
      clearDuplicates();
      clearQueue();
    }
  }, [duplicateFiles, selectedDuplicateGroup, clearDuplicates, clearQueue]);

  const handleTrashStaged = useCallback(async () => {
    await trashStaged();
    if (selectedDuplicateGroup !== null && workspaceScan) {
      const candidate = workspaceScan.duplicateCandidates.find((c) => c.id === selectedDuplicateGroup);
      if (candidate) await selectDuplicateCandidate(candidate);
    }
    await refreshWorkspaceIndex();
  }, [trashStaged, selectedDuplicateGroup, workspaceScan, selectDuplicateCandidate, refreshWorkspaceIndex]);

  const handleOpenDuplicateCandidate = useCallback(
    async (candidate: Parameters<typeof selectDuplicateCandidate>[0]) => {
      await selectDuplicateCandidate(candidate);
      document.getElementById("duplicates")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [selectDuplicateCandidate]
  );

  useEffect(() => {
    if (!workspaceScan || selectedDuplicateGroup !== null) return;
    const firstCandidate = workspaceScan.duplicateCandidates.find(
      (candidate) => candidate.id !== undefined && candidate.files >= 2
    );
    if (firstCandidate) void selectDuplicateCandidate(firstCandidate);
  }, [workspaceScan, selectedDuplicateGroup, selectDuplicateCandidate]);

  const workspaceSortedFolders = useMemo(() => {
    if (!workspaceScan) return [];
    return [...workspaceScan.folders].sort((a, b) => b.bytes - a.bytes);
  }, [workspaceScan]);

  const workspaceFilteredFolders = useMemo(() => {
    if (!workspaceScan) return [];
    const categoryFolders =
      filter === "all"
        ? workspaceScan.folders.map((folder) => ({ ...folder, displayBytes: folder.bytes }))
        : workspaceScan.folders
            .filter((folder) => folder.categories[filter] > 0)
            .map((folder) => ({ ...folder, displayBytes: folder.categories[filter] }));

    if (!focusedFolder) {
      return categoryFolders.sort((a, b) => b.displayBytes - a.displayBytes).slice(0, 48);
    }

    const childFolders = categoryFolders.filter((f) => parentPath(f.path) === focusedFolder);
    const descendantFolders = categoryFolders.filter(
      (f) => f.path !== focusedFolder && isDescendantPath(f.path, focusedFolder)
    );
    const focused = childFolders.length > 0 ? childFolders : descendantFolders;
    return focused.sort((a, b) => b.displayBytes - a.displayBytes).slice(0, 48);
  }, [filter, focusedFolder, workspaceScan]);

  if (!workspaceScan || !workspaceIndexPath) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 pb-32">
        <p className="font-mono text-11 uppercase tracking-[2px] text-white/30">No Scan Loaded</p>
        <p className="max-w-[400px] text-center text-sm text-muted">
          Start a scan from Home or load a saved index from Library.
        </p>
        <div className="flex gap-3">
          <Link
            to="/"
            className="inline-flex min-h-[42px] items-center justify-center border border-primary/50 px-5 font-mono text-11 font-black uppercase text-primary no-underline"
          >
            → Go Home
          </Link>
          <Link
            to="/library"
            className="inline-flex min-h-[42px] items-center justify-center border border-white/15 px-5 font-mono text-11 font-black uppercase text-muted no-underline"
          >
            → Open Library
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <CommandPalette currentIndexPath={workspaceIndexPath} nativeRuntime={nativeRuntime} scan={workspaceScan} />
      <section className="relative z-[1] min-w-0 px-[42px] pb-[118px] max-sm:px-4 max-sm:pb-28">
        <header className="mb-4.5 grid gap-2 border-t border-primary/20 pt-5">
          <p className="m-0 text-13 font-bold uppercase text-accent">Workspace / storage intelligence</p>
          <h2 className="max-w-[860px] text-[clamp(28px,3vw,46px)] font-black uppercase leading-[0.95] text-primary">
            Indexed terrain and cleanup surfaces
          </h2>
          <span className="max-w-[760px] text-sm leading-normal text-muted">
            Treemap, duplicate candidates, and saved local indexes remain live below.{" "}
            <kbd className="border border-white/15 px-1 font-mono text-10 text-white/40">Ctrl+K</kbd> to search files.
          </span>
        </header>
        <MetricGrid scan={workspaceScan} />
        <FilterBar filter={filter} setFilter={setFilter} />
        <AnalysisSection
          filteredFolders={workspaceFilteredFolders}
          focusedFolder={focusedFolder}
          lens={treemapLens}
          lensData={treemapLensMap}
          setFocusedFolder={setFocusedFolder}
          setLens={setTreemapLens}
          onOpenDuplicateCandidate={(candidate) => void handleOpenDuplicateCandidate(candidate)}
          scan={workspaceScan}
        />
        <FoldersTable sortedFolders={workspaceSortedFolders} nativeRuntime={nativeRuntime} />
        <DetailGrid
          largestFiles={workspaceScan.largestFiles}
          extensions={workspaceScan.extensions}
          nativeRuntime={nativeRuntime}
        />
        <DuplicatesSection
          duplicateCandidates={workspaceScan.duplicateCandidates}
          selectedDuplicateGroup={selectedDuplicateGroup}
          selectDuplicateCandidate={selectDuplicateCandidate}
          duplicateFiles={duplicateFiles}
          comparisonCursor={comparisonCursor}
          setComparisonCursor={setComparisonCursor}
          staged={staged}
          stagedBytes={stagedBytes}
          stage={stage}
          unstage={unstage}
          trashStaged={handleTrashStaged}
          trashProgress={trashProgress}
          dismissProgress={dismissProgress}
          nativeRuntime={nativeRuntime}
        />
      </section>
    </>
  );
}
