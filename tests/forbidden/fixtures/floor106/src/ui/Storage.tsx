import { useEffect, useState, useSyncExternalStore } from "react";

const okModuleHelper = () => localStorage.getItem("ok-module-helper");
const badModuleRead = localStorage.getItem("bad-module-read");

export function readOkHelper() {
  return localStorage.getItem("ok-plain-function");
}

export function Prefs({ id }: { id: string }) {
  const badRenderRead = localStorage.getItem("bad-render-read");
  const [badLazyState] = useState(() => sessionStorage.getItem("bad-lazy-state"));
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    setValue(localStorage.getItem("ok-effect-read"));
  }, []);
  const stored = useSyncExternalStore(
    () => () => {},
    () => localStorage.getItem("ok-external-store"),
    () => null,
  );
  const onSave = () => {
    localStorage.setItem("ok-handler", id);
  };
  if (typeof localStorage === "undefined") return null;
  return (
    <button onClick={() => localStorage.removeItem("ok-inline-handler")}>
      {value}{stored}{badRenderRead}{badLazyState}{String(okModuleHelper)}{String(badModuleRead)}{String(onSave)}
    </button>
  );
}
