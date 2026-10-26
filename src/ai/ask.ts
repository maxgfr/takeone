/**
 * Asking the AI in plain words: "cut the intro", "make it 30 seconds", "zoom
 * when I click Save", "bring back the sentence about pricing", "fix the
 * transcript". The model reads the whole transcript (cut words marked, so it
 * can bring them back), the screen's changes and stills, what was asked
 * before, and the request; it answers with the changes (cuts, words brought
 * back, zooms, layouts, blurs, chapters, words corrected) and a reply. They
 * land as one undo step, each listed to drop; whatever points outside the
 * takes is dropped, never trusted.
 */
import type { LlmSettings } from "llm-connect";
import { z } from "zod";
import { chapterList, chapterMarks } from "../edit/chapters";
import { isCut, wordsRange } from "../edit/clean";
import { outputDuration, type Range, segmentsOf } from "../edit/timeline";
import { reword } from "../edit/transcribe";
import {
  type Blur,
  type Chapter,
  type ClipTranscript,
  type Cut,
  type LayoutRange,
  newId,
  type Project,
  rawDuration,
  type Zoom,
} from "../model/project";
import { AiError, call, visionProblem } from "./call";
import {
  type EditNote,
  editInput,
  editSchema,
  gatherStills,
  planFromAnswer,
  type StillRef,
  stillImages,
} from "./edit";
import { askPrompt, clock } from "./prompts";
import { chaptersFromAnswer } from "./tools";

/** Stills sent at most with a request. */
const ASK_STILLS = 10;

const span = {
  take: z.number().int().describe("Take number, from 1"),
  from: z.number().int().describe("Number of the first word"),
  to: z.number().int().describe("Number of the last word"),
};

export const askSchema = z.object({
  reply: z.string(),
  cut: z.array(z.object({ ...span, why: z.string() })),
  restore: z.array(z.object(span)),
  fix: z.array(
    z.object({
      take: z.number().int(),
      word: z.number().int().describe("Number of the word recognised wrong"),
      text: z.string().describe("What was really said there"),
    }),
  ),
  zooms: editSchema.shape.zooms,
  layouts: editSchema.shape.layouts,
  blurs: editSchema.shape.blurs,
  chapters: z
    .array(z.object({ take: z.number().int(), word: z.number().int(), title: z.string() }))
    .nullable(),
});
export type AskAnswer = z.infer<typeof askSchema>;

/** A request made earlier in the conversation, and what the model answered. */
export interface Exchange {
  request: string;
  reply: string;
}

export interface AskPlan {
  reply: string;
  cuts: Cut[];
  /** Ranges of takes whose cuts go. */
  restore: (Range & { clip: string })[];
  zooms: Zoom[];
  layouts: LayoutRange[];
  blurs: Blur[];
  chapters: Chapter[] | null;
  /** A take's text, corrected: its text before, to drop the correction. */
  fixes: { clip: string; before: ClipTranscript; after: ClipTranscript }[];
  notes: EditNote[];
}

/** What the model reads: the takes with every word (cut ones marked), the video's length, the chapters, what was asked before, and the request. */
export function askInput(
  p: Project,
  stills: readonly StillRef[],
  request: string,
  history: readonly Exchange[] = [],
): string {
  const lines = [
    editInput(p, stills, { showCut: true }),
    "",
    `EDITED VIDEO: ${clock(outputDuration(segmentsOf(p)))} (the takes last ${clock(rawDuration(p))} before cuts).`,
  ];
  const list = chapterList(chapterMarks(p, segmentsOf(p)));
  if (list) lines.push(`CHAPTERS:\n${list}`);
  if (history.length) {
    lines.push("", "EARLIER REQUESTS:");
    for (const h of history.slice(-4))
      lines.push(`- ${JSON.stringify(h.request)} → ${JSON.stringify(h.reply)}`);
  }
  lines.push("", `REQUEST: ${request}`);
  return lines.join("\n");
}

function quote(words: readonly { text: string }[]): string {
  const text = words.map((w) => w.text).join(" ");
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Removes `r` from the take's cuts, splitting the ones it falls inside. */
export function uncut(cuts: readonly Cut[], clip: string, r: Range): Cut[] {
  return cuts.flatMap((c) => {
    if (c.clip !== clip || c.end <= r.start || c.start >= r.end) return [c];
    const parts: Cut[] = [];
    if (c.start < r.start) parts.push({ ...c, end: r.start });
    if (c.end > r.end) parts.push({ ...c, id: newId("x"), start: r.end });
    return parts.filter((x) => x.end - x.start > 0.02);
  });
}

/** The plan applied: cuts brought back and added, the new zooms, layouts, blurs and chapters. */
export function applyAsk(
  p: Project,
  plan: Pick<AskPlan, "cuts" | "restore" | "zooms" | "layouts" | "blurs" | "chapters">,
): Project {
  let cuts = [...p.cuts];
  for (const r of plan.restore) cuts = uncut(cuts, r.clip, r);
  return {
    ...p,
    cuts: [...cuts, ...plan.cuts],
    zooms: [...p.zooms, ...plan.zooms],
    layouts: [...p.layouts, ...plan.layouts],
    blurs: [...p.blurs, ...plan.blurs],
    chapters: plan.chapters ?? p.chapters,
  };
}

/** The model's answer as changes to the project; what points outside the takes is dropped. */
export function planFromAsk(p: Project, answer: AskAnswer, stills: readonly StillRef[]): AskPlan {
  const visual = planFromAnswer(p, answer, stills);
  const notes: EditNote[] = [];

  const restore: AskPlan["restore"] = [];
  for (const r of answer.restore) {
    const clip = p.clips[r.take - 1];
    const words = clip?.transcript?.words ?? [];
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    if (!clip || from < 0 || to >= words.length) continue;
    const span = words.slice(from, to + 1);
    if (!span.some((w) => isCut(p.cuts, clip.id, w))) continue;
    const range = wordsRange(words, from, to);
    if (!range) continue;
    restore.push({ clip: clip.id, ...range });
    notes.push({
      kind: "cut",
      id: "",
      clip: clip.id,
      t: range.start,
      what: `Brought back “${quote(span)}”`,
      why: "",
    });
  }
  const restored = applyAsk(p, { ...empty, restore });

  const cuts: Cut[] = [];
  for (const c of [...answer.cut].sort((a, b) => a.take - b.take || a.from - b.from)) {
    const clip = p.clips[c.take - 1];
    const words = clip?.transcript?.words ?? [];
    const from = Math.min(c.from, c.to);
    const to = Math.max(c.from, c.to);
    if (!clip || from < 0 || to >= words.length) continue;
    const span = words.slice(from, to + 1);
    if (span.every((w) => isCut(restored.cuts, clip.id, w))) continue;
    const range = wordsRange(words, from, to);
    if (!range) continue;
    const cut: Cut = { id: newId("x"), clip: clip.id, ...range, reason: "ai" };
    cuts.push(cut);
    notes.push({
      kind: "cut",
      id: cut.id,
      clip: clip.id,
      t: range.start,
      what: `Cut “${quote(span)}”`,
      why: c.why.trim(),
    });
  }
  // A request never empties the video: that is a misunderstanding, not an edit.
  const after = { ...restored, cuts: [...restored.cuts, ...cuts] };
  const left = after.clips.some((c) =>
    c.transcript?.words.some((w) => !isCut(after.cuts, c.id, w)),
  );
  if (cuts.length && !left)
    throw new AiError("The model wanted to cut the whole video: nothing was changed. Ask again.");

  let chapters: Chapter[] | null = null;
  if (answer.chapters) {
    chapters = chaptersFromAnswer(after, { chapters: answer.chapters });
    for (const c of chapters)
      notes.push({
        kind: "chapter",
        id: c.id,
        clip: c.clip,
        t: c.t,
        what: `Chapter: ${c.title}`,
        why: "",
      });
  }

  const fixes: AskPlan["fixes"] = [];
  for (const [i, clip] of p.clips.entries()) {
    const before = clip.transcript;
    if (!before) continue;
    const mine = answer.fix
      .filter((f) => f.take === i + 1 && f.word >= 0 && f.word < before.words.length)
      .filter((f) => f.text.trim() !== before.words[f.word]?.text)
      // From the last word back, so the numbers of the others hold when one becomes several.
      .sort((a, b) => b.word - a.word);
    const seen = new Set<number>();
    let t = before;
    const changes: string[] = [];
    for (const f of mine) {
      if (seen.has(f.word)) continue;
      seen.add(f.word);
      changes.unshift(`${before.words[f.word]?.text} → ${f.text.trim() || "∅"}`);
      t = reword(t, f.word, f.text.trim());
    }
    if (!changes.length) continue;
    fixes.push({ clip: clip.id, before, after: t });
    notes.push({
      kind: "fix",
      id: `fix-${clip.id}`,
      clip: clip.id,
      t: before.words[mine[mine.length - 1]?.word ?? 0]?.start ?? 0,
      what: `${changes.length} word${changes.length === 1 ? "" : "s"} corrected`,
      why: changes.slice(0, 6).join(", ") + (changes.length > 6 ? "…" : ""),
    });
  }

  return {
    reply: answer.reply.trim(),
    cuts,
    restore,
    zooms: visual.zooms,
    layouts: visual.layouts,
    blurs: visual.blurs,
    chapters,
    fixes,
    notes: [...notes, ...visual.notes].sort(
      (a, b) =>
        p.clips.findIndex((c) => c.id === a.clip) - p.clips.findIndex((c) => c.id === b.clip) ||
        a.t - b.t,
    ),
  };
}

const empty = { cuts: [], restore: [], zooms: [], layouts: [], blurs: [], chapters: null };

export interface AskOptions {
  history?: readonly Exchange[];
  /** Show the model stills of the screen (for zooms and blurs), when it can see. */
  see?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** What the model would change for the request, without changing anything yet. */
export async function askEdit(
  settings: LlmSettings,
  p: Project,
  request: string,
  options: AskOptions = {},
): Promise<AskPlan> {
  if (!p.clips.some((c) => c.transcript?.words.length))
    throw new AiError("Transcribe the takes first, or write their text: the AI works from it.");
  const say = options.onProgress ?? (() => {});
  const canSee = !!options.see && visionProblem(settings) === null;
  if (canSee) say("Looking at the screen…");
  const stills = canSee ? await gatherStills(settings, p, ASK_STILLS) : [];
  say("Reading the transcript…");
  const answer = await call(settings, {
    name: "ask",
    schema: askSchema,
    instructions: askPrompt(stills.length > 0, p.style.layout),
    text: askInput(p, stills, request, options.history),
    images: stillImages(p, stills),
    effort: "medium",
    signal: options.signal,
  });
  return planFromAsk(p, answer, stills);
}
