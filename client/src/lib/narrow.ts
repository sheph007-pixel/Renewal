import { useEffect, useState } from "react";

/** Below this the rail stops being a column, and the Medical Plans toolbar folds into a Filters drawer. */
export const RAIL_WIDTH = "(max-width: 860px)";

/** True while the viewport is too narrow for a side rail. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(RAIL_WIDTH).matches);
  useEffect(() => {
    const mq = window.matchMedia(RAIL_WIDTH);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
