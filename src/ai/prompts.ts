/**
 * The words sent to the model, kept apart from the plumbing so they can be
 * read, tested and tuned on their own. The transcript goes out take by take:
 * numbered word by word when the answer points at words (retakes, chapters),
 * as plain edited text when it only reads it (titles, posts). Prompts are in
 * English; answers come in the language asked for, the video's by default.
 */
import { languageName } from "llm-connect";
import { isCut } from "../edit/clean";
import type { Project } from "../model/project";

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The language the takes were spoken in, as a code or a name (the first take that says). */
export function spokenLanguage(p: Project): string | null {
  for (const c of p.clips) if (c.transcript?.language) return c.transcript.language;
  return null;
}

/** Every take's kept words, numbered from 0 in each take: `[12]word`. Cut words are left out. */
export function numberedTranscript(p: Project): string {
  return p.clips
    .map((c, i) => {
      const words = c.transcript?.words ?? [];
      const kept = words.flatMap((w, n) => (isCut(p.cuts, c.id, w) ? [] : [`[${n}]${w.text}`]));
      return `TAKE ${i + 1}\n${kept.length ? kept.join(" ") : "(no speech)"}`;
    })
    .join("\n\n");
}

/** What the viewer hears: the kept words of every take, take after take. */
export function editedText(p: Project): string {
  return p.clips
    .map((c) =>
      (c.transcript?.words ?? [])
        .filter((w) => !isCut(p.cuts, c.id, w))
        .map((w) => w.text)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

const CONTEXT =
  "The video is a screen recording: someone shows their screen (a product, a website, code) and talks over it, in one or several takes.";

function writeIn(language: string): string {
  return `Write every text in ${languageName(language)}.`;
}

export function retakesPrompt(language: string): string {
  return [
    `You edit the transcript of a video. ${CONTEXT} People record in one go, so they sometimes fail a sentence and say it again. Find those failed attempts so they can be cut.`,
    "- The transcript comes take by take, every word numbered: [12]word. Numbers restart at 0 in each take. Words already cut are left out.",
    '- A retake is a failed or repeated attempt: a sentence started then restarted ("So this is the— so this is the dashboard"), a stumble followed by a clean repeat, or the speaker talking about the recording itself ("wait, let me redo that", "sorry, again", "cut this").',
    "- Return the words to cut: from the first to the last word of the failed attempt, with any comment about the recording, so that the clean attempt that follows is kept as it was said. Never return the clean attempt.",
    "- Leave everything else: repetitions made on purpose, emphasis, enumerations, and filler words like um or uh (they are removed separately).",
    "- When in doubt, leave it out. An empty list is a fine answer.",
    `- \`reason\`: three to six words saying what went wrong, in ${languageName(language)}.`,
  ].join("\n");
}

export function chaptersPrompt(language: string, duration: number): string {
  return [
    `You split a video into chapters, like YouTube chapters, from its transcript. ${CONTEXT} The edited video lasts ${clock(duration)}.`,
    "- The transcript comes take by take, every word numbered: [12]word. Numbers restart at 0 in each take.",
    "- A chapter starts where a new topic, step or part of the demo starts. Return the take and the number of the word it starts at, and a title.",
    "- The first chapter starts at the first word of take 1.",
    `- About one chapter per minute: between 2 and 12, fewer for a short video. Each covers several sentences.`,
    "- Titles: two to five words, plain, no numbering, no trailing punctuation.",
    writeIn(language),
  ].join("\n");
}

export function textsPrompt(language: string): string {
  return [
    `You write the title and the texts of a video from its transcript. ${CONTEXT}`,
    "- title: what the video shows, specific, at most 70 characters, no quotes, no clickbait, no emoji.",
    "- summary: two or three sentences saying what the viewer will see and learn.",
    "- description: one or two short paragraphs for the page the video is shared on. No hashtags, no timestamps.",
    "- Use the product's and the speaker's own vocabulary. Never invent a feature, a number or a name that is not in the transcript.",
    writeIn(language),
  ].join("\n");
}

export function postsPrompt(language: string): string {
  return [
    `You write posts that share a video, from its transcript. ${CONTEXT}`,
    "- linkedin: a first line that makes people stop, then three to five short paragraphs on what the video shows and why it matters, then an invitation to watch. At most three hashtags, at the end. No emoji walls.",
    "- x: one post of at most 260 characters, plain and specific; at most one hashtag.",
    "- youtube: a description of one or two short paragraphs. Do not write chapters or timestamps: they are added after it.",
    "- Leave a place for the link as [link] where it belongs, once per post.",
    "- Use the product's and the speaker's own vocabulary. Never invent a feature, a number or a name that is not in the transcript.",
    writeIn(language),
  ].join("\n");
}

export function translatePrompt(language: string, title: string): string {
  const lang = languageName(language);
  return [
    `You translate the captions of a video into ${lang}. ${CONTEXT} The video is titled ${JSON.stringify(title)}.`,
    "- You receive the captions as JSON, a list of {n, text}. Return the same list, the same numbers, each caption translated.",
    "- One caption in, one caption out: never merge, split, drop or reorder them, even when a sentence runs over two captions.",
    "- Keep them spoken and about as long as the original, so they can be read in the same time.",
    "- Product and company names, code, and the labels of buttons, menus and fields on screen stay as they are.",
    `- A caption already in ${lang} is kept as it is.`,
  ].join("\n");
}
