import { useScanContext } from "../context/ScanContext";
import { LandingPage } from "../components/LandingPage";

export function HomePage() {
  const {
    scan,
    nativeRuntime,
    fileInputRef,
    openFolderPicker,
    handleFiles,
  } = useScanContext();

  return (
    <LandingPage
      scan={scan}
      nativeRuntime={nativeRuntime}
      fileInputRef={fileInputRef}
      openFolderPicker={openFolderPicker}
      handleFiles={handleFiles}
    />
  );
}
