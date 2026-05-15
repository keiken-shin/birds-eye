import { useEffect, useState } from "react";
import { isNativeRuntime } from "../nativeClient";

export function useNativeRuntime(): {
  nativeRuntime: boolean;
  runtimeMessage: string;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
} {
  const [nativeRuntime, setNativeRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("Browser preview");

  useEffect(() => {
    void isNativeRuntime().then((native) => {
      setNativeRuntime(native);
      setRuntimeMessage(native ? "Native index mode" : "Browser preview");
    });
  }, []);

  return { nativeRuntime, runtimeMessage, setRuntimeMessage };
}
