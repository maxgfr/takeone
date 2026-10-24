/**
 * The side panel: what the selected item is (a zoom, a layout, a blur, a cut)
 * with its actions, then the look of the whole video.
 */
import { removeItem } from "../../edit/ops";
import { outputSpans } from "../../edit/timeline";
import {
  ASPECTS,
  CORNERS,
  LAYOUTS,
  type LayoutKind,
  type Project,
  type Style,
} from "../../model/project";
import { BACKGROUNDS } from "../../render/compose";
import { clock } from "../Record";
import { Button, Field } from "../ui";
import { CaptionsSection } from "./CaptionsSection";
import { project, segments, selection, update } from "./state";

export const LAYOUT_NAMES: Record<LayoutKind, string> = {
  bubble: "Screen + bubble",
  screen: "Screen only",
  camera: "Camera only",
  side: "Side by side",
};

const ASPECT_NAMES: Record<string, string> = {
  "16:9": "16:9 · landscape",
  "9:16": "9:16 · vertical",
  "1:1": "1:1 · square",
  "4:3": "4:3",
};

function gradient(name: string): string {
  const g = BACKGROUNDS[name];
  return g ? `linear-gradient(135deg, ${g[0]}, ${g[1]})` : name === "none" ? "#000" : name;
}

function setStyle(patch: (s: Style) => Style, tag: string) {
  update((p) => ({ ...p, style: patch(p.style) }), tag);
}

function SelectionPanel({ p }: { p: Project }) {
  const s = selection.value;
  if (!s) return null;
  const segs = segments.value;
  const remove = () => {
    update((x) => removeItem(x, s.kind, s.id));
    selection.value = null;
  };
  const when = (item: { clip: string; start: number; end: number }) => {
    const spans = outputSpans(segs, item.clip, item);
    const a = spans[0];
    const b = spans[spans.length - 1];
    return a && b ? `${clock(a.start)} – ${clock(b.end)}` : "cut out of the video";
  };
  if (s.kind === "zoom") {
    const z = p.zooms.find((x) => x.id === s.id);
    if (!z) return null;
    return (
      <section class="insp-section">
        <h3>Zoom · {when(z)}</h3>
        <p class="muted small">
          {(1 / z.box.w).toFixed(1)}× {z.auto ? "· suggested from your clicks" : ""}. Drag the frame
          on the preview to move it; drag its corner to resize it.
        </p>
        <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
          Remove zoom
        </Button>
      </section>
    );
  }
  if (s.kind === "blur") {
    const b = p.blurs.find((x) => x.id === s.id);
    if (!b) return null;
    return (
      <section class="insp-section">
        <h3>Blur · {when(b)}</h3>
        <p class="muted small">Drag the box on the preview over what must not be seen.</p>
        <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
          Remove blur
        </Button>
      </section>
    );
  }
  if (s.kind === "layout") {
    const l = p.layouts.find((x) => x.id === s.id);
    if (!l) return null;
    return (
      <section class="insp-section">
        <h3>Layout · {when(l)}</h3>
        <select
          class="input"
          aria-label="Layout of this part"
          value={l.layout}
          onChange={(e) =>
            update((x) => ({
              ...x,
              layouts: x.layouts.map((r) =>
                r.id === l.id ? { ...r, layout: e.currentTarget.value as LayoutKind } : r,
              ),
            }))
          }
        >
          {LAYOUTS.map((k) => (
            <option key={k} value={k}>
              {LAYOUT_NAMES[k]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
          Back to the default layout
        </Button>
      </section>
    );
  }
  const c = p.cuts.find((x) => x.id === s.id);
  if (!c) return null;
  return (
    <section class="insp-section">
      <h3>Cut · {(c.end - c.start).toFixed(1)} s</h3>
      <Button size="sm" icon="undo" onClick={remove}>
        Restore
      </Button>
    </section>
  );
}

export function Inspector() {
  const p = project.value;
  if (!p) return null;
  const st = p.style;
  return (
    <aside class="inspector" aria-label="Settings">
      <SelectionPanel p={p} />
      <section class="insp-section">
        <h3>Format</h3>
        <select
          class="input"
          aria-label="Format"
          value={st.aspect}
          onChange={(e) =>
            setStyle((s) => ({ ...s, aspect: e.currentTarget.value as Style["aspect"] }), "aspect")
          }
        >
          {ASPECTS.map((a) => (
            <option key={a} value={a}>
              {ASPECT_NAMES[a]}
            </option>
          ))}
        </select>
      </section>
      <section class="insp-section">
        <h3>Layout</h3>
        <fieldset class="segmented segmented-wrap" aria-label="Default layout">
          {LAYOUTS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={st.layout === k}
              class={st.layout === k ? "is-on" : ""}
              onClick={() => setStyle((s) => ({ ...s, layout: k }), "layout")}
            >
              {LAYOUT_NAMES[k]}
            </button>
          ))}
        </fieldset>
        <p class="muted small">Select a range on the timeline to give it another layout.</p>
      </section>
      <section class="insp-section">
        <h3>Background</h3>
        <div class="swatches">
          {[...Object.keys(BACKGROUNDS), "none"].map((name) => (
            <button
              key={name}
              type="button"
              class={`swatch ${st.background === name ? "is-active" : ""}`}
              style={{ background: gradient(name) }}
              aria-label={name}
              aria-pressed={st.background === name}
              title={name}
              onClick={() => setStyle((s) => ({ ...s, background: name }), "bg")}
            />
          ))}
          <input
            type="color"
            class="swatch swatch-color"
            aria-label="Background color"
            value={st.background.startsWith("#") ? st.background : "#202030"}
            onInput={(e) => setStyle((s) => ({ ...s, background: e.currentTarget.value }), "bg")}
          />
        </div>
        <label class="slider">
          Padding
          <input
            type="range"
            class="range"
            min={0}
            max={0.12}
            step={0.005}
            value={st.padding}
            onInput={(e) =>
              setStyle((s) => ({ ...s, padding: Number(e.currentTarget.value) }), "pad")
            }
          />
        </label>
        <label class="slider">
          Corners
          <input
            type="range"
            class="range"
            min={0}
            max={0.06}
            step={0.002}
            value={st.radius}
            onInput={(e) =>
              setStyle((s) => ({ ...s, radius: Number(e.currentTarget.value) }), "radius")
            }
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={st.shadow}
            onChange={(e) => setStyle((s) => ({ ...s, shadow: e.currentTarget.checked }), "shadow")}
          />
          Shadow
        </label>
      </section>
      <section class="insp-section">
        <h3>Camera</h3>
        <Field label="Bubble corner">
          <select
            class="input"
            value={st.bubble.corner}
            onChange={(e) =>
              setStyle(
                (s) => ({
                  ...s,
                  bubble: {
                    ...s.bubble,
                    corner: e.currentTarget.value as Style["bubble"]["corner"],
                  },
                }),
                "corner",
              )
            }
          >
            {CORNERS.map((c) => (
              <option key={c} value={c}>
                {c.replace("-", " ")}
              </option>
            ))}
          </select>
        </Field>
        <label class="slider">
          Bubble size
          <input
            type="range"
            class="range"
            min={0.12}
            max={0.45}
            step={0.01}
            value={st.bubble.size}
            onInput={(e) =>
              setStyle(
                (s) => ({ ...s, bubble: { ...s.bubble, size: Number(e.currentTarget.value) } }),
                "bsize",
              )
            }
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={st.bubble.shape === "circle"}
            onChange={(e) =>
              setStyle(
                (s) => ({
                  ...s,
                  bubble: { ...s.bubble, shape: e.currentTarget.checked ? "circle" : "rounded" },
                }),
                "shape",
              )
            }
          />
          Round bubble
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={st.bubble.mirror}
            onChange={(e) =>
              setStyle(
                (s) => ({ ...s, bubble: { ...s.bubble, mirror: e.currentTarget.checked } }),
                "mirror",
              )
            }
          />
          Mirror the camera
        </label>
      </section>
      <CaptionsSection />
      <section class="insp-section">
        <h3>Sound</h3>
        <label class="slider">
          The screen's own sound
          <input
            type="range"
            class="range"
            min={0}
            max={1}
            step={0.05}
            value={st.audio.screenVolume}
            onInput={(e) =>
              setStyle(
                (s) => ({
                  ...s,
                  audio: { ...s.audio, screenVolume: Number(e.currentTarget.value) },
                }),
                "svol",
              )
            }
          />
        </label>
      </section>
    </aside>
  );
}
