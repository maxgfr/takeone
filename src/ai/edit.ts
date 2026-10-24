/**
 * The AI edit: the model reads what was said (numbered words, with times),
 * where the screen changed while recording, and stills of the screen with a
 * grid, and places zooms on what is being talked about, layouts for the parts
 * that call for another one, and blurs over personal data it sees. Next to it,
 * the retakes and the chapters come from their own requests, and filler words
 * and long pauses from the transcript alone. Everything becomes ordinary edit
 * items, marked `auto` so that running it again replaces them, applied in one
 * undo step. Whatever points outside the takes is dropped, never trusted.
 */
import type { LlmSettings } from "llm-connect";
import { z } from "zod";
import { fillerCuts, isCut, silenceCuts } from "../edit/clean";
import { clampBox } from "../edit/ops";
import { frameRegion, groupActivity } from "../edit/zooms";
import {
  type Blur,
  type Box,
  type Chapter,
  type Clip,
  type Cut,
  LAYOUTS,
  type LayoutRange,
  newId,
  type Project,
  type Zoom,
} from "../model/project";
import { AiError, call, visionProblem } from "./call";
import { editPrompt } from "./prompts";
import { type Still, screenStills, stillBudget, stillTimes } from "./stills";
import { answerLanguage, findChapters, findRetakes, retakeCut } from "./tools";

/** A change that covers more than this share of the screen is a new page (or a scroll). */
const PAGE_CHANGE = 0.25;
/** Stills sent at most, over every take. */
const MAX_STILLS = 16;

const regionSchema = z.object({
  x: z.number().describe("Left edge, 0–1 of the screen's width"),
  y: z.number().describe("Top edge, 0–1 of the screen's height"),
  w: z.number().describe("Width, 0–1"),
  h: z.number().describe("Height, 0–1"),
});

export const editSchema = z.object({
  zooms: z.array(
    z.object({
      take: z.number().int().describe("Take number, from 1"),
      from: z.number().int().describe("Number of the first word the zoom covers"),
      to: z.number().int().describe("Number of the last word the zoom covers"),
      region: regionSchema,
      why: z.string(),
    }),
  ),
  layouts: z.array(
    z.object({
      take: z.number().int(),
      from: z.number().int(),
      to: z.number().int(),
      layout: z.enum(LAYOUTS),
      why: z.string(),
    }),
  ),
  blurs: z.array(
    z.object({
      frame: z.string().describe("The still it is seen on, such as F3"),
      region: regionSchema,
      why: z.string(),
    }),
  ),
});
export type EditAnswer = z.infer<typeof editSchema>;

export interface StillRef {
  id: string;
  clip: string;
  t: number;
}

function clock(t: number): string {
  return `${t.toFixed(1)}s`;
}

/** The word a time falls on (or the next one), by its number in the take. */
function wordAt(clip: Clip, t: number): number | null {
  const words = clip.transcript?.words ?? [];
  const i = words.findIndex((w) => w.end >= t);
  return i < 0 ? null : i;
}

/**
 * What the model reads: each take's kept words, numbered as in the take and timed every few
 * seconds, the screen's changes, and the stills it will see.
 */
export function editInput(p: Project, stills: readonly StillRef[]): string {
  const screen = p.clips.find((c) => c.screen)?.screen;
  const lines = [
    screen?.width ? `SCREEN: ${screen.width}×${screen.height} pixels.` : "SCREEN: unknown size.",
    `DEFAULT LAYOUT: ${p.style.layout}.`,
  ];
  for (const [i, c] of p.clips.entries()) {
    lines.push(
      "",
      `TAKE ${i + 1} (${clock(c.duration)}, ${c.camera ? "camera" : "no camera"}, ${c.screen ? "screen" : "no screen"})`,
    );
    const words = c.transcript?.words ?? [];
    let mark = Number.NEGATIVE_INFINITY;
    const kept = words.flatMap((w, n) => {
      if (isCut(p.cuts, c.id, w)) return [];
      const timed = w.start - mark >= 3;
      if (timed) mark = w.start;
      return [timed ? `[${n}|${clock(w.start)}]${w.text}` : `[${n}]${w.text}`];
    });
    lines.push(`Words: ${kept.length ? kept.join(" ") : "(no speech)"}`);
    const changes = groupActivity(c.activity);
    if (changes.length) {
      lines.push("Screen changes:");
      for (const g of changes) {
        const b = g.box;
        const n = wordAt(c, g.start);
        lines.push(
          `- ${clock(g.start)}–${clock(g.end)}${n === null ? "" : ` (word ${n})`}: x=${b.x.toFixed(2)} y=${b.y.toFixed(2)} w=${b.w.toFixed(2)} h=${b.h.toFixed(2)}`,
        );
      }
    }
    const mine = stills.filter((s) => s.clip === c.id);
    if (mine.length)
      lines.push(
        `Stills: ${mine
          .map((s) => {
            const n = wordAt(c, s.t);
            return `${s.id} at ${clock(s.t)}${n === null ? "" : ` (word ${n})`}`;
          })
          .join(", ")}`,
      );
  }
  return lines.join("\n");
}

/** The words `from`–`to` of a take, as a time range, or null when they are not there. */
function wordsSpan(clip: Clip, from: number, to: number): { start: number; end: number } | null {
  const words = clip.transcript?.words ?? [];
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const first = words[a];
  const last = words[b];
  if (!first || !last || a < 0) return null;
  return { start: first.start, end: last.end };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Where the screen around `t` stays the same page: from the change before to the change after. */
export function samePage(clip: Clip, t: number): { start: number; end: number } {
  let start = 0;
  let end = clip.duration;
  for (const e of clip.activity) {
    if (e.box.w * e.box.h < PAGE_CHANGE && e.ratio < PAGE_CHANGE) continue;
    if (e.t <= t) start = Math.max(start, e.t);
    else end = Math.min(end, e.t);
  }
  return { start, end };
}

export interface EditNote {
  kind: "zoom" | "layout" | "blur" | "cut" | "chapter";
  id: string;
  clip: string;
  /** On the take's clock. */
  t: number;
  what: string;
  why: string;
}

export interface EditPlan {
  zooms: Zoom[];
  layouts: LayoutRange[];
  blurs: Blur[];
  cuts: Cut[];
  chapters: Chapter[] | null;
  notes: EditNote[];
}

/** The model's answer as edit items; whatever points outside the takes is dropped. */
export function planFromAnswer(
  p: Project,
  answer: EditAnswer,
  stills: readonly StillRef[],
): Pick<EditPlan, "zooms" | "layouts" | "blurs" | "notes"> {
  const notes: EditNote[] = [];
  const zooms: Zoom[] = [];
  for (const z of [...answer.zooms].sort((a, b) => a.take - b.take || a.from - b.from)) {
    const clip = p.clips[z.take - 1];
    if (!clip?.screen) continue;
    const span = wordsSpan(clip, z.from, z.to);
    if (!span) continue;
    const start = Math.max(0, span.start - 0.5);
    const end = Math.min(clip.duration, Math.max(span.end + 0.7, start + 1.5));
    const box = frameRegion(clampBox(z.region as Box));
    // Barely closer is not worth a zoom.
    if (1 / box.w < 1.25) continue;
    const range = { start, end };
    if (
      zooms.some(
        (o) =>
          o.clip === clip.id && overlaps(o, { start: range.start - 0.3, end: range.end + 0.3 }),
      )
    )
      continue;
    const zoom: Zoom = { id: newId("z"), clip: clip.id, start, end, box, auto: true };
    zooms.push(zoom);
    notes.push({
      kind: "zoom",
      id: zoom.id,
      clip: clip.id,
      t: start,
      what: `Zoom ${(1 / box.w).toFixed(1)}×`,
      why: z.why.trim(),
    });
  }

  const layouts: LayoutRange[] = [];
  for (const l of answer.layouts) {
    const clip = p.clips[l.take - 1];
    if (!clip || l.layout === p.style.layout) continue;
    if (l.layout !== "screen" && !clip.camera) continue;
    if ((l.layout === "screen" || l.layout === "side") && !clip.screen) continue;
    const span = wordsSpan(clip, l.from, l.to);
    if (!span) continue;
    const start = Math.max(0, span.start - 0.2);
    const end = Math.min(clip.duration, span.end + 0.3);
    if (end - start < 3) continue;
    if (layouts.some((o) => o.clip === clip.id && overlaps(o, { start, end }))) continue;
    const layout: LayoutRange = {
      id: newId("l"),
      clip: clip.id,
      start,
      end,
      layout: l.layout,
      auto: true,
    };
    layouts.push(layout);
    notes.push({
      kind: "layout",
      id: layout.id,
      clip: clip.id,
      t: start,
      what: `Layout: ${l.layout}`,
      why: l.why.trim(),
    });
  }

  const blurs: Blur[] = [];
  for (const b of answer.blurs) {
    const still = stills.find((s) => s.id === b.frame.trim().toUpperCase());
    const clip = still && p.clips.find((c) => c.id === still.clip);
    if (!still || !clip?.screen) continue;
    const r = b.region;
    if (r.w <= 0 || r.h <= 0 || r.w * r.h > 0.5) continue;
    const pad = 0.01;
    const box = clampBox({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
    const page = samePage(clip, still.t);
    const blur: Blur = { id: newId("b"), clip: clip.id, ...page, box, auto: true };
    blurs.push(blur);
    notes.push({
      kind: "blur",
      id: blur.id,
      clip: clip.id,
      t: page.start,
      what: "Blur",
      why: b.why.trim(),
    });
  }
  return { zooms, layouts, blurs, notes };
}

export interface EditOptions {
  /** Zooms, layouts and blurs from the screen and the words. */
  visual: boolean;
  retakes: boolean;
  /** Filler words and long pauses. */
  clean: boolean;
  chapters: boolean;
  language: string | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** Everything the AI edit would change, without changing anything yet. */
export async function planEdit(
  settings: LlmSettings,
  p: Project,
  options: EditOptions,
): Promise<EditPlan> {
  if (!p.clips.some((c) => c.transcript?.words.length))
    throw new AiError("Transcribe the takes first: the AI edits from what was said.");
  const say = options.onProgress ?? (() => {});
  const language = answerLanguage(p, options.language);
  const signal = options.signal;

  const visual = async () => {
    if (!options.visual) return null;
    const canSee = visionProblem(settings) === null;
    const stills: (StillRef & Still)[] = [];
    if (canSee) {
      say("Looking at the screen…");
      const budget = stillBudget(p.clips, MAX_STILLS);
      for (const [i, c] of p.clips.entries()) {
        const shots = await screenStills(p.id, c, stillTimes(c, budget[i] ?? 0));
        for (const s of shots) stills.push({ ...s, id: `F${stills.length + 1}`, clip: c.id });
      }
    }
    say("Placing zooms, layouts and blurs…");
    const answer = await call(settings, {
      name: "edit",
      schema: editSchema,
      instructions: editPrompt(language, canSee, p.style.layout),
      text: editInput(p, stills),
      images: stills.map((s) => {
        const take = p.clips.findIndex((c) => c.id === s.clip) + 1;
        return { label: `${s.id}: take ${take} at ${clock(s.t)}`, jpeg: s.jpeg };
      }),
      effort: "medium",
      signal,
    });
    return planFromAnswer(p, answer, stills);
  };

  const [placed, retakes, chapters] = await Promise.all([
    visual(),
    options.retakes ? findRetakes(settings, p, options.language, signal) : Promise.resolve([]),
    // Chapters are a bonus: when the model finds none usable, the rest of the edit still applies.
    options.chapters
      ? findChapters(settings, p, options.language, signal).catch((err) => {
          if (signal?.aborted || !(err instanceof AiError)) throw err;
          return null;
        })
      : Promise.resolve(null),
  ]);

  const notes = [...(placed?.notes ?? [])];
  const cuts: Cut[] = [];
  for (const r of retakes) {
    const cut = retakeCut(r);
    cuts.push(cut);
    notes.push({
      kind: "cut",
      id: cut.id,
      clip: r.clip,
      t: r.start,
      what: `Cut “${r.text}”`,
      why: r.reason,
    });
  }
  if (options.clean) {
    const fillers = p.clips.flatMap((c) => fillerCuts(c, [...p.cuts, ...cuts]));
    const pauses = p.clips.flatMap((c) => silenceCuts(c, [...p.cuts, ...cuts, ...fillers]));
    cuts.push(...fillers, ...pauses);
    if (fillers.length)
      notes.push({
        kind: "cut",
        id: "",
        clip: fillers[0]?.clip ?? "",
        t: fillers[0]?.start ?? 0,
        what: `${fillers.length} filler word${fillers.length === 1 ? "" : "s"} cut`,
        why: "",
      });
    if (pauses.length)
      notes.push({
        kind: "cut",
        id: "",
        clip: pauses[0]?.clip ?? "",
        t: pauses[0]?.start ?? 0,
        what: `${pauses.length} long pause${pauses.length === 1 ? "" : "s"} cut`,
        why: "",
      });
  }
  for (const c of chapters ?? [])
    notes.push({
      kind: "chapter",
      id: c.id,
      clip: c.clip,
      t: c.t,
      what: `Chapter: ${c.title}`,
      why: "",
    });

  return {
    zooms: placed?.zooms ?? [],
    layouts: placed?.layouts ?? [],
    blurs: placed?.blurs ?? [],
    cuts,
    chapters,
    notes,
  };
}

/** The plan applied: earlier automatic zooms, layouts and blurs give way to the new ones. */
export function applyPlan(p: Project, plan: EditPlan, visual: boolean): Project {
  return {
    ...p,
    zooms: visual ? [...p.zooms.filter((z) => !z.auto), ...plan.zooms] : p.zooms,
    layouts: visual ? [...p.layouts.filter((l) => !l.auto), ...plan.layouts] : p.layouts,
    blurs: visual ? [...p.blurs.filter((b) => !b.auto), ...plan.blurs] : p.blurs,
    cuts: [...p.cuts, ...plan.cuts],
    chapters: plan.chapters ?? p.chapters,
  };
}
