/**
 * The timeline, on the output's clock: the takes as they play (with a mark
 * where something was cut), then a row each for layouts, zooms and blurs.
 * Click to move the playhead, drag across the video row to select a range,
 * click a block to select it.
 */
import { signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { PreviewEngine } from "../../edit/preview";
import { outputSpans, type Range } from "../../edit/timeline";
import { clock } from "../Record";
import { duration, project, segments, selection } from "./state";

/** The output range selected on the video row, if any. */
export const range = signal<Range | null>(null);

const TAKE_COLORS = ["#ff7a59", "#6d5efc", "#10b981", "#f5c542", "#22d3ee", "#d16ba5"];

const LAYOUT_LABEL = { bubble: "Bubble", screen: "Screen", camera: "Camera", side: "Side by side" };

function ticks(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => total / s <= 12) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(t);
  return out;
}

/** Reads the clock every frame, on its own. */
function Playhead({ engine, total }: { engine: PreviewEngine | null; total: number }) {
  const now = engine?.time.value ?? 0;
  return (
    <div
      class="tl-playhead"
      style={{ left: `${total ? (now / total) * 100 : 0}%` }}
      aria-hidden="true"
    />
  );
}

export function Timeline({ engine }: { engine: PreviewEngine | null }) {
  const box = useRef<HTMLDivElement>(null);
  const p = project.value;
  const total = duration.value;
  const segs = segments.value;
  if (!p) return null;
  const pct = (t: number) => `${total ? (t / total) * 100 : 0}%`;
  const now = engine?.time.peek() ?? 0;
  const order = new Map(p.clips.map((c, i) => [c.id, i]));

  const timeAt = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !total) return 0;
    return Math.max(0, Math.min(total, ((clientX - r.left) / r.width) * total));
  };

  const scrub = (e: PointerEvent, select: boolean) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = timeAt(e.clientX);
    engine?.seek(start);
    if (select) range.value = null;
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      engine?.seek(t);
      if (select && Math.abs(t - start) > total / 400)
        range.value = { start: Math.min(start, t), end: Math.max(start, t) };
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const row = <T extends { id: string; clip: string; start: number; end: number }>(
    items: readonly T[],
    kind: "layout" | "zoom" | "blur",
    label: (item: T) => string,
    extra?: (item: T) => string,
  ) =>
    items.flatMap((item) =>
      outputSpans(segs, item.clip, item).map((span, i) => (
        <button
          key={`${item.id}-${i}`}
          type="button"
          class={`tl-item tl-${kind} ${extra?.(item) ?? ""} ${selection.value?.id === item.id ? "is-selected" : ""}`}
          style={{ left: pct(span.start), width: pct(span.end - span.start) }}
          title={`${label(item)} · ${clock(span.start)}–${clock(span.end)}`}
          onClick={(e) => {
            e.stopPropagation();
            selection.value = { kind, id: item.id };
            engine?.seek(span.start);
          }}
        >
          {label(item)}
        </button>
      )),
    );

  // Where cuts were made: the joins between kept pieces of one take.
  const joins = segs.flatMap((s, i) => {
    const prev = segs[i - 1];
    return prev && prev.clip.id === s.clip.id ? [s.at] : [];
  });

  return (
    <div class="timeline">
      <div class="tl-labels" aria-hidden="true">
        <span />
        <span>Video</span>
        <span>Layout</span>
        <span>Zoom</span>
        <span>Blur</span>
      </div>
      <div class="tl-body" ref={box}>
        <div class="tl-ruler" onPointerDown={(e) => scrub(e, false)} role="presentation">
          {ticks(total).map((t) => (
            <span key={t} class="tl-tick" style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
        </div>
        <div
          class="tl-track tl-video"
          onPointerDown={(e) => scrub(e, true)}
          role="slider"
          aria-label="Position in the video"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(now)}
          tabIndex={0}
        >
          {segs.map((s) => {
            const i = order.get(s.clip.id) ?? 0;
            return (
              <div
                key={`${s.clip.id}-${s.start}`}
                class="tl-seg"
                style={{
                  left: pct(s.at),
                  width: pct(s.end - s.start),
                  "--take": TAKE_COLORS[i % TAKE_COLORS.length],
                }}
              >
                Take {i + 1}
              </div>
            );
          })}
          {joins.map((t) => (
            <span key={t} class="tl-join" style={{ left: pct(t) }} title="A cut" />
          ))}
          {range.value && (
            <div
              class="tl-range"
              style={{
                left: pct(range.value.start),
                width: pct(range.value.end - range.value.start),
              }}
            />
          )}
        </div>
        <div class="tl-track">{row(p.layouts, "layout", (l) => LAYOUT_LABEL[l.layout])}</div>
        <div class="tl-track">
          {row(
            p.zooms,
            "zoom",
            (z) => `${(1 / z.box.w).toFixed(1)}×`,
            (z) => (z.auto ? "is-auto" : ""),
          )}
        </div>
        <div class="tl-track">{row(p.blurs, "blur", () => "Blur")}</div>
        <Playhead engine={engine} total={total} />
      </div>
    </div>
  );
}
