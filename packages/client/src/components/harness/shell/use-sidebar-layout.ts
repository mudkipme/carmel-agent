import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clampSidebarWidth,
  DESKTOP_SIDEBAR_QUERY,
  getDefaultSidebarOpen,
  getDefaultSidebarWidth,
  resetSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "./sidebar-utils";

export function useSidebarLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_SIDEBAR_QUERY);
    const syncSidebarDefault = () => setSidebarOpen(mediaQuery.matches);
    syncSidebarDefault();
    mediaQuery.addEventListener("change", syncSidebarDefault);
    return () => mediaQuery.removeEventListener("change", syncSidebarDefault);
  }, []);

  const closeSidebarOnMobile = useCallback(() => {
    if (!window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches) setSidebarOpen(false);
  }, []);

  const endSidebarResize = useRef<(() => void) | null>(null);
  // A drag that outlives the component would keep calling setState from window
  // listeners, so the unmount cleanup removes them and restores the cursor.
  useEffect(() => () => endSidebarResize.current?.(), []);

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches) return;
    event.preventDefault();
    endSidebarResize.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let width = startWidth;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    setSidebarResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const finishResize = () => {
      endSidebarResize.current = null;
      setSidebarResizing(false);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      // Saved once, when the drag ends, rather than on every pointer move.
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    const resize = (moveEvent: PointerEvent) => {
      width = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(width);
    };

    endSidebarResize.current = () => {
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const onResetWidth = useCallback(() => resetSidebarWidth(setSidebarWidth), []);
  const onResizeWidth = useCallback((width: number) => {
    setSidebarWidth(width);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  }, []);

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    sidebarResizing,
    closeSidebarOnMobile,
    startSidebarResize,
    onResetWidth,
    onResizeWidth,
  };
}
