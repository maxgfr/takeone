/**
 * The editor: the preview, the timeline under it, and the settings beside it.
 * The toolbar acts on the range selected on the timeline (or a couple of
 * seconds from the playhead): cut it, zoom on it, blur something in it, give
 * it another layout.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { addBlur, addZoom, cutRange, setLayout } from "../../edit/ops";
import { PreviewEngine } from "../../edit/preview";
import type { Range } from "../../edit/timeline";
import { suggestZooms } from "../../edit/zooms";
import { LAYOUTS, type LayoutKind } from "../../model/project";
import { clock } from "../Record";
import { navigate } from "../router";
import { Button, IconButton, toast } from "../ui";
import { Inspector, LAYOUT_NAMES } from "./Inspector";
import { Stage } from "./Stage";
import {
  closeProject,
  duration,
  history,
  mediaUrl,
  openProject,
  project,
  redo,
  saveError,
  segments,
  selection,
  undo,
  update,
} from "./state";
import { range, Timeline } from "./Timeline";

/** These read the clock every frame: kept small so the rest of the editor does not redraw. */
function PlayButton({ engine }: { engine: PreviewEngine | null }) {
  const playing = engine?.playing.value ?? false;
  return (
    <Button
      variant="primary"
      icon={playing ? "pause" : "play"}
      onClick={() => engine?.toggle()}
      aria-label={playing ? "Pause" : "Play"}
    >
      {playing ? "Pause" : "Play"}
    </Button>
  );
}

function TimeCode({ engine }: { engine: PreviewEngine | null }) {
  return (
    <span class="tc">
      {clock(engine?.time.value ?? 0)} / {clock(duration.value)}
    </span>
  );
}

/** The selected range, or two seconds from the playhead. */
function workingRange(t: number): Range {
  return range.value ?? { start: t, end: Math.min(duration.value, t + 2) };
}

export function Editor({ id }: { id: string }) {
  const loaded = useSignal<"loading" | "ok" | "missing">("loading");
  const engine = useRef<PreviewEngine | null>(null);
  const ready = useSignal(false);

  useEffect(() => {
    let live = true;
    void openProject(id).then((ok) => {
      if (live) loaded.value = ok ? "ok" : "missing";
    });
    return () => {
      live = false;
      engine.current?.dispose();
      engine.current = null;
      range.value = null;
      closeProject();
    };
  }, [id]);

  // Every edit redraws the preview.
  const p = project.value;
  useEffect(() => {
    if (p && engine.current) engine.current.setProject(p);
  }, [p, ready.value]);

  const onCanvas = (c: HTMLCanvasElement) => {
    engine.current = new PreviewEngine(c, mediaUrl);
    ready.value = true;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const eng = engine.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === " ") {
        e.preventDefault();
        eng?.toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
        eng?.seek(eng.time.value + d);
      } else if ((e.key === "Delete" || e.key === "Backspace") && range.value) {
        e.preventDefault();
        cut();
      } else if (e.key === "Escape") {
        range.value = null;
        selection.value = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loaded.value === "missing")
    return (
      <main class="page">
        <p>This project is not on this device.</p>
        <Button onClick={() => navigate("#/")}>Home</Button>
      </main>
    );
  if (!p) return <main class="editor" />;

  const t = () => engine.current?.time.peek() ?? 0;

  const cut = () => {
    const r = range.value;
    if (!r) return;
    update((x) => cutRange(x, segments.value, r));
    range.value = null;
    engine.current?.seek(r.start);
    toast("Cut. Undo with ⌘Z, or restore it from the timeline.");
  };
  const zoom = () => {
    const res = addZoom(project.value ?? p, segments.value, workingRange(t()));
    if (!res.id) return;
    update(() => res.project);
    selection.value = { kind: "zoom", id: res.id };
  };
  const blur = () => {
    const res = addBlur(project.value ?? p, segments.value, workingRange(t()));
    if (!res.id) return;
    update(() => res.project);
    selection.value = { kind: "blur", id: res.id };
  };
  const layout = (k: LayoutKind) => {
    update((x) => setLayout(x, segments.value, workingRange(t()), k));
  };
  const autoZooms = () => {
    update((x) => ({
      ...x,
      zooms: [...x.zooms.filter((z) => !z.auto), ...x.clips.flatMap((c) => suggestZooms(c))],
    }));
    toast("Zooms placed where the screen changed.");
  };

  return (
    <main class="editor">
      <header class="ed-top">
        <IconButton icon="back" label="Home" onClick={() => navigate("#/")} />
        <input
          class="ed-title"
          aria-label="Title"
          value={p.title}
          onInput={(e) => update((x) => ({ ...x, title: e.currentTarget.value }), "title")}
        />
        {saveError.value && <span class="error small">Not saved: {saveError.value}</span>}
        <span class="ed-spacer" />
        <IconButton icon="undo" label="Undo" disabled={!history.value.undo} onClick={undo} />
        <IconButton icon="redo" label="Redo" disabled={!history.value.redo} onClick={redo} />
        <Button icon="record" onClick={() => navigate(`#/record?project=${p.id}`)}>
          Add a take
        </Button>
      </header>
      <div class="ed-main">
        <section class="ed-center">
          <Stage engine={engine.current} onCanvas={onCanvas} />
          <div class="transport">
            <PlayButton engine={engine.current} />
            <TimeCode engine={engine.current} />
            <span class="ed-spacer" />
            <div class="toolbar" role="toolbar" aria-label="Edit">
              <Button size="sm" icon="trash" disabled={!range.value} onClick={cut}>
                Cut
              </Button>
              <Button size="sm" icon="zoom" onClick={zoom}>
                Zoom
              </Button>
              <Button size="sm" icon="blur" onClick={blur}>
                Blur
              </Button>
              <select
                class="input input-sm"
                aria-label="Layout of the selection"
                value=""
                onChange={(e) => {
                  const v = e.currentTarget.value as LayoutKind;
                  if (v) layout(v);
                  e.currentTarget.value = "";
                }}
              >
                <option value="">Layout…</option>
                {LAYOUTS.map((k) => (
                  <option key={k} value={k}>
                    {LAYOUT_NAMES[k]}
                  </option>
                ))}
              </select>
              <Button size="sm" icon="wand" onClick={autoZooms}>
                Auto zooms
              </Button>
            </div>
          </div>
          <Timeline engine={engine.current} />
          <p class="muted small ed-hint">
            Space plays. Drag across the video row to select, then Cut (Delete), Zoom, Blur or a
            layout. Click a block to edit it.
          </p>
        </section>
        <Inspector />
      </div>
    </main>
  );
}
