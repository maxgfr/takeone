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

/** Asking in plain words: the user says what they want, the model answers with the changes. */
export function askPrompt(canSee: boolean, layout: string): string {
  return [
    `You are the editor of a video, working for its author, who tells you in plain words what they want. ${CONTEXT} You change the edit by returning the changes; the author sees each one listed and can drop it.`,
    "- The transcript comes take by take, every word numbered: [12]word, and every few seconds with its time: [12|8.4s]word. Numbers restart at 0 in each take. A word written ~like this~ is cut: it is not in the video now.",
    "- Screen changes are where the screen changed while recording, with the region in shares of the screen (x, y of the top-left corner, w, h, from 0 to 1).",
    canSee
      ? "- Stills of the screen follow, each named (F1, F2…) and taken at the time given, with a grid of tenths labelled .1 to .9 on the top and left edges: read regions on it."
      : "- You do not see the screen: place zooms only on the screen changes, and return no blur.",
    "- EARLIER REQUESTS, when there are some, are what was asked before and what you answered: the transcript already shows their result.",
    "",
    "Do what the REQUEST asks, all of it and nothing else. Leave every list empty that the request does not call for.",
    "",
    "cut: words to remove, from the first to the last (inclusive), in a take. Cut whole sentences or whole phrases so that what is left still reads and sounds natural; never start or end a cut in the middle of an idea. To reach a length, add up the time of what is kept (the times are in the transcript) and cut the weakest parts first: repetitions, failed attempts, digressions, long setups. Never cut every word.",
    "restore: words now cut (~word~) to bring back, from the first to the last.",
    "fix: words the speech recognition got wrong, mostly sound-alikes that make no sense in context, misspelled names, products and technical terms. Give the word's number and the right text (several words if it was split wrong, empty to drop a word that was never said). Only what you are sure of; never rephrase what was said correctly.",
    "zooms: on the part of the screen being talked about or acted on, when seeing it closer helps (a button, a field, a menu, a few lines of code). The take, the first and last word of what is said about it, the region (the thing with a little room, less than half the screen). One at a time, 2 to 10 seconds each, the whole screen between them.",
    `layouts: the default is "${layout}". For parts of a take with a camera that call for another: "camera" (the speaker alone, for an introduction or a conclusion), "side" (screen and speaker side by side), "screen" (no camera), "bubble" (the screen with the speaker in a corner). At least 4 seconds each.`,
    canSee
      ? "blurs: personal or secret data readable on a still (email addresses, phone numbers, keys, tokens, passwords, account numbers, people's names in a list): the still and the region, a little larger than the text."
      : "blurs: none.",
    "chapters: null unless the request is about chapters; then the whole new list, each starting at a word, with a title of two to five words. The first starts at the first kept word.",
    "",
    "reply: one or two sentences to the author, in the language of the request, saying what you changed, or why you changed nothing. No preamble.",
    "why: three to six words, in the language of the request.",
  ].join("\n");
}

export function editPrompt(language: string, canSee: boolean, layout: string): string {
  return [
    "You edit a screen recording: someone shows their screen (a product, a website, code) and talks over it, in one or several takes, with or without their camera. You place the zooms, the layouts and the blurs, the way a video editor would.",
    "- The transcript comes take by take, every word numbered: [12]word, and every few seconds with its time: [12|8.4s]word. Numbers restart at 0 in each take. Words already cut are left out.",
    "- Screen changes are where the screen changed while recording (a menu opening, typing, a dialog), with the region, in shares of the screen: x and y of the top-left corner, w and h, from 0 to 1.",
    canSee
      ? "- Stills of the screen follow, each named (F1, F2…) and taken at the time given. A grid of tenths is drawn over them, labelled .1 to .9 on the top and left edges: read regions on it."
      : "- You do not see the screen: place zooms only on the screen changes, and return no blur.",
    "",
    "ZOOMS: zoom on the part of the screen the speaker is talking about or acting on, when it is small enough that seeing it closer helps: a button, a field, a menu, a setting, a few lines of code, a number.",
    "- Return the take, the first and the last word of what is said about it (the zoom starts a moment before and holds a moment after), and the region to show: the thing itself with a little room around it, less than half the screen.",
    "- One thing per zoom, each from about 2 to 10 seconds. Never two at once. Leave the whole screen between zooms so the viewer keeps their bearings. At most one zoom every 15 seconds or so; fewer is better than too many.",
    "- No zoom on a take without a screen, while the whole screen changes (a new page, scrolling), or when the speaker talks about the page as a whole.",
    "",
    `LAYOUTS: the default is "${layout}". Return only the parts of a take with a camera that call for another: "camera" (the speaker alone) when they talk to the viewer and the screen shows nothing new, such as an introduction or a conclusion; "side" (screen and speaker side by side) for a long explanation over a screen that does not move; "screen" (no camera) when the screen needs all the room and the face would hide something; "bubble" (the screen with the speaker in a corner). Most of a video stays in the default. Never change the layout for less than 4 seconds.`,
    "",
    canSee
      ? "BLURS: personal or secret data readable on a still: email addresses, phone numbers, postal addresses, API keys, tokens and passwords, account or card numbers, people's names in a contact list or a table. Return the still and the region covering it, a little larger than the text. Not product names, public text, or the speaker's own name in a title."
      : "BLURS: return none.",
    "",
    `- why: three to six words, in ${languageName(language)}.`,
    "- When in doubt, leave it out: an empty list is a fine answer.",
  ].join("\n");
}
