/**
 * The preview canvas, and over it the region being edited when a zoom or a
 * blur is selected: drag it to move it, drag its corner to resize it. While a
 * zoom's region is edited, the preview shows the whole screen.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { clampBox } from "../../edit/ops";
import type { PreviewEngine } from "../../edit/preview";
import type { Box } from "../../model/project";
import { outputSize } from "../../render/compose";
import { project, selection, update } from "./state";

function selectedRegion(): { kind: "zoom" | "blur"; id: string; box: Box; clip: string } | null {
  const p = project.value;
  const s = selection.value;
  if (!p || !s) return null;
  if (s.kind === "zoom") {
    const z = p.zooms.find((x) => x.id === s.id);
    return z ? { kind: "zoom", id: z.id, box: z.box, clip: z.clip } : null;
  }
  if (s.kind === "blur") {
    const b = p.blurs.find((x) => x.id === s.id);
    return b ? { kind: "blur", id: b.id, box: b.box, clip: b.clip } : null;
  }
  return null;
}

export function Stage({
  engine,
  onCanvas,
}: {
  engine: PreviewEngine | null;
  onCanvas: (c: HTMLCanvasElement) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tick = useSignal(0);
  const fit = useSignal<{ w: number; h: number } | null>(null);
  const aspect = project.value ? outputSize(project.value.style.aspect, 720) : { w: 16, h: 9 };

  // The canvas is as large as the stage allows, at the output's aspect ratio.
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = aspect.w / aspect.h;
      const w = Math.min(el.clientWidth, el.clientHeight * r);
      fit.value = { w: Math.floor(w), h: Math.floor(w / r) };
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [aspect.w, aspect.h]);
  const region = selectedRegion();

  useEffect(() => {
    if (canvas.current) onCanvas(canvas.current);
  }, []);

  useEffect(() => {
    if (!engine) return;
    engine.fullView = region?.kind === "zoom";
    // The overlay follows the placement of the screen, which moves with layouts.
    let raf = 0;
    const loop = () => {
      tick.value++;
      raf = requestAnimationFrame(loop);
    };
    if (region) raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, region?.id, region?.kind]);

  const c = canvas.current;
  const shown = engine?.placement;
  const rect = shown?.placement.screen;
  let overlay = null;
  void tick.value;
  if (region && c && rect && shown?.clip === region.clip && c.width) {
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    const x = rect.x + region.box.x * rect.w;
    const y = rect.y + region.box.y * rect.h;
    const w = region.box.w * rect.w;
    const h = region.box.h * rect.h;
    const drag = (mode: "move" | "resize") => (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, box: region.box };
      const scale = c.getBoundingClientRect().width / c.width;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / scale / rect.w;
        const dy = (ev.clientY - start.y) / scale / rect.h;
        let box: Box;
        if (mode === "move") box = { ...start.box, x: start.box.x + dx, y: start.box.y + dy };
        else if (region.kind === "zoom") {
          // A zoom keeps the screen's aspect ratio: as wide as it is high, in shares.
          const size = Math.max(start.box.w + dx, start.box.h + dy);
          box = { ...start.box, w: size, h: size };
        } else box = { ...start.box, w: start.box.w + dx, h: start.box.h + dy };
        const next = clampBox(box);
        update(
          (p) =>
            region.kind === "zoom"
              ? {
                  ...p,
                  zooms: p.zooms.map((z) =>
                    z.id === region.id ? { ...z, box: next, auto: false } : z,
                  ),
                }
              : {
                  ...p,
                  blurs: p.blurs.map((b) =>
                    b.id === region.id ? { ...b, box: next, auto: false } : b,
                  ),
                },
          `${region.id}:box`,
        );
      };
      const upHandler = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", upHandler);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", upHandler);
    };
    overlay = (
      <div
        class={`region region-${region.kind}`}
        style={{
          left: pct(x, c.width),
          top: pct(y, c.height),
          width: pct(w, c.width),
          height: pct(h, c.height),
        }}
        onPointerDown={drag("move")}
        role="presentation"
      >
        <span class="region-label">{region.kind === "zoom" ? "Zoom" : "Blur"}</span>
        <span class="region-handle" onPointerDown={drag("resize")} role="presentation" />
      </div>
    );
  }

  return (
    <div class="stage" ref={stage}>
      <div
        class="stage-frame"
        style={fit.value ? { width: `${fit.value.w}px`, height: `${fit.value.h}px` } : undefined}
      >
        <canvas ref={canvas} class="stage-canvas" aria-label="Preview" />
        {overlay}
      </div>
    </div>
  );
}
