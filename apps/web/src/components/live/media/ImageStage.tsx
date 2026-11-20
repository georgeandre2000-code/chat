import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DraftMark } from "./DraftMark";
import { MediaPins } from "./MediaPins";
import { type Mark, type MediaPin, markOf } from "./marks";

/** Room around the picture inside the stage (pixels): at its sides, over it (the zoom island) and under it (the dock). */
export const STAGE_PAD = { x: 40, top: 64, bottom: 80 };

export type MediaTool = "move" | "comment";

/** What every stage shows over its picture: the comments, the one being written, and what the person does. */
export interface StageMarks {
  pins: readonly MediaPin[];
  focusId: string | null;
  showResolved: boolean;
  /** The comment being written: its mark, the number it will have, and the person's own face. */
  draft: { mark: Mark; n: number } | null;
  /** A PDF's comment being written: the page it is on. */
  draftPage?: number;
  tool: MediaTool;
  onOpenPin: (messageId: string) => void;
}

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * A picture on its page (ADR 0208): fitted in the stage, larger with the zoom (`zoom` 1 = fitted) and moved by
 * dragging once larger; the comments pinned on it, and with Comment on, a click marks a point and a drag an area
 * (`onMark`, with the picture's element to take its pictures from).
 */
export function ImageStage({
  src,
  width,
  height,
  zoom,
  marks,
  alt,
  onMark,
  onSize,
}: {
  src: string;
  /** The picture's own size when known (its header said it); else read when it loads. */
  width?: number;
  height?: number;
  zoom: number;
  marks: StageMarks;
  alt: string;
  onMark: (mark: Mark, picture: HTMLImageElement) => void;
  onSize?: (size: { w: number; h: number }) => void;
}) {
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();
  const img = useRef<HTMLImageElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    width && height ? { w: width, h: height } : null,
  );
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Back to fitted: centered again.
  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  const w = natural?.w ?? 0;
  const h = natural?.h ?? 0;
  const roomW = stage.w - STAGE_PAD.x * 2;
  const roomH = stage.h - STAGE_PAD.top - STAGE_PAD.bottom;
  const fit = w && h ? Math.min(roomW / w, roomH / h, 1) : 0;
  const scale = Math.max(0, fit) * zoom;
  const boxW = w * scale;
  const boxH = h * scale;
  const left = STAGE_PAD.x + (roomW - boxW) / 2 + pan.x;
  const top = STAGE_PAD.top + (roomH - boxH) / 2 + pan.y;

  // The comment open now, on a larger picture: brought into view.
  const focus = marks.pins.find((p) => p.message.id === marks.focusId)?.selection.mark;
  // biome-ignore lint/correctness/useExhaustiveDependencies: moves once per comment opened
  useEffect(() => {
    if (!focus || zoom <= 1 || !boxW) return;
    const cx = (focus.x + (focus.w ?? 0) / 2) * boxW;
    const cy = (focus.y + (focus.h ?? 0) / 2) * boxH;
    setPan({ x: boxW / 2 - cx, y: boxH / 2 - cy });
  }, [marks.focusId]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (marks.tool === "comment") {
      const r = box.current?.getBoundingClientRect();
      if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDrag({ from: { x: e.clientX, y: e.clientY }, to: { x: e.clientX, y: e.clientY } });
      return;
    }
    if (zoom > 1) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panning.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ from: drag.from, to: { x: e.clientX, y: e.clientY } });
    const p = panning.current;
    if (p) setPan({ x: p.px + e.clientX - p.x, y: p.py + e.clientY - p.y });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    panning.current = null;
    if (!drag) return;
    const r = box.current?.getBoundingClientRect();
    const mark = r ? markOf(drag.from, { x: e.clientX, y: e.clientY }, r) : null;
    setDrag(null);
    if (mark && img.current) onMark(mark, img.current);
  };

  // While dragging an area: its outline, in the box's fractions.
  const r = drag ? box.current?.getBoundingClientRect() : null;
  const dragging = drag && r ? markOf(drag.from, drag.to, r) : null;

  return (
    <div
      ref={stageRef}
      className="mf-stage"
      data-tool={marks.tool}
      data-zoomed={zoom > 1 || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        panning.current = null;
        setDrag(null);
      }}
    >
      <div
        ref={box}
        className="mf-box"
        style={{
          left,
          top,
          width: boxW || undefined,
          height: boxH || undefined,
          visibility: boxW ? "visible" : "hidden",
        }}
      >
        <img
          ref={img}
          className="mf-img"
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            const size = { w: el.naturalWidth, h: el.naturalHeight };
            if (!natural || natural.w !== size.w || natural.h !== size.h) setNatural(size);
            onSize?.(size);
          }}
        />
        <MediaPins
          pins={marks.pins}
          focusId={marks.focusId}
          showResolved={marks.showResolved}
          onOpen={marks.onOpenPin}
        />
        {dragging?.w !== undefined ? <DraftMark mark={dragging} /> : marks.draft && <DraftMark {...marks.draft} />}
      </div>
    </div>
  );
}
