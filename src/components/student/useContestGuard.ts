import { useEffect, useRef } from "react";
import type { ViolationType } from "@/lib/types";

const CLIENT_DEBOUNCE_MS = 1500;
const KEY_TO_TYPE: Record<string, ViolationType> = { c: "copy", v: "paste", x: "cut" };

/**
 * Listens for prohibited actions while `active` is true and reports each distinct
 * action once (keydown + clipboard events for the same action are collapsed).
 */
export function useContestGuard(active: boolean, onViolation: (type: ViolationType, opts?: { unloading?: boolean }) => void) {
  const handlerRef = useRef(onViolation);
  handlerRef.current = onViolation;

  useEffect(() => {
    if (!active) return;
    const last: Partial<Record<ViolationType, number>> = {};
    const report = (type: ViolationType, opts?: { unloading?: boolean }) => {
      const now = Date.now();
      if (now - (last[type] ?? 0) < CLIENT_DEBOUNCE_MS) return;
      last[type] = now;
      handlerRef.current(type, opts);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const type = KEY_TO_TYPE[e.key.toLowerCase()];
      if (type) {
        e.preventDefault();
        report(type);
      }
    };
    const onClipboard = (e: ClipboardEvent) => {
      e.preventDefault();
      report(e.type as ViolationType);
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) report("fullscreen_exit");
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") report("tab_switch");
    };
    const onPageHide = () => report("fullscreen_exit", { unloading: true });
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onClipboard, true);
    document.addEventListener("cut", onClipboard, true);
    document.addEventListener("paste", onClipboard, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onClipboard, true);
      document.removeEventListener("cut", onClipboard, true);
      document.removeEventListener("paste", onClipboard, true);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [active]);
}
