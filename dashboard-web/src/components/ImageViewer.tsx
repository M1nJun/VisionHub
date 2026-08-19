import { useEffect, useRef, useState } from "react";

export interface FlatImage {
  defectId: number;
  judgeDefect: string;
  judge: string;
  side: string;
  occurredAt: string;
  mainUrl: string | null;
  overlayUrl: string | null;
  fetchStatus: string;
}

interface Props {
  images: FlatImage[]; // already filtered + sorted newest-first by the caller
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;

export default function ImageViewer({ images }: Props) {
  const [index, setIndex] = useState(0);
  const [showOverlay, setShowOverlay] = useState(false);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);

  // Deliberately NOT reacting to `images` changing here: the parent re-fetches
  // on every poll (5s default), which gives `images` a new array identity
  // every time even when the content is unchanged - resetting to image 0 on
  // every render would yank the viewer back to the first photo out from
  // under anyone mid-review. The parent instead remounts this component
  // (via a `key` tied to the selected defect type) when the filter actually
  // changes, which naturally resets all state here through React's normal
  // remount behavior - no effect needed.

  function resetView() {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  function next() {
    setIndex((i) => Math.min(i + 1, images.length - 1));
    resetView();
  }

  function prev() {
    setIndex((i) => Math.max(i - 1, 0));
    resetView();
  }

  function onWheel(e: React.WheelEvent) {
    // Only hijack the wheel event when zooming (Ctrl/Cmd+scroll) - a plain
    // scroll over the image needs to keep scrolling the page like anywhere
    // else on the site, not get eaten by this canvas.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
  }

  function onMouseDown(e: React.MouseEvent) {
    if (scale <= 1) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  function stopDrag() {
    dragging.current = false;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length]);

  if (images.length === 0) {
    return <div className="empty-state">No images for this filter yet.</div>;
  }

  // Defensive clamp: if new defects arrive while browsing, the list can grow
  // between polls without this component remounting (only a filter change
  // does that) - clamping avoids an out-of-range read rather than crashing.
  const clampedIndex = Math.min(index, images.length - 1);
  const current = images[clampedIndex];
  const url = showOverlay ? current.overlayUrl : current.mainUrl;

  return (
    <div className="image-viewer">
      <div
        ref={canvasRef}
        className="viewer-canvas"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {url ? (
          <img
            src={url}
            alt={`${current.judgeDefect} ${current.side}`}
            draggable={false}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          />
        ) : (
          <div className="viewer-empty">
            {current.fetchStatus === "pending" ? "Fetching..." : "Unavailable"}
          </div>
        )}
      </div>

      <div className="viewer-controls">
        <button onClick={prev} disabled={clampedIndex === 0}>&larr; Prev</button>
        <span>{clampedIndex + 1} / {images.length}</span>
        <button onClick={next} disabled={clampedIndex === images.length - 1}>Next &rarr;</button>
        <label>
          <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} />
          Overlay
        </label>
        <button onClick={resetView}>Reset zoom</button>
        <span style={{ color: "var(--text-dim)" }}>Ctrl+Scroll to zoom, drag to pan</span>
      </div>

      <div className="viewer-caption">
        {current.judgeDefect} &middot; {current.judge} &middot; {current.side} &middot;{" "}
        {new Date(current.occurredAt).toLocaleString()}
      </div>
    </div>
  );
}
