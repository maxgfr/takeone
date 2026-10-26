/**
 * The project: the takes as recorded (clips), and the edit laid over them.
 * Nothing in the edit touches the media: cuts, layouts, zooms and blurs are
 * time ranges on a clip's own clock (seconds from the start of its screen
 * recording), so they stay put whatever is cut before them, and every edit
 * can be undone. `parseProject` is the only way in: it validates and fills
 * defaults, so older projects open in newer versions.
 */
import { z } from "zod";

export const PROJECT_VERSION = 1;

export const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Box = z.infer<typeof boxSchema>;

const pieceSchema = z.object({ text: z.string(), start: z.number(), end: z.number() });

export const transcriptSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(pieceSchema),
  words: z.array(pieceSchema),
  wordTimings: z.enum(["exact", "estimated", "none"]),
  /** Where the text came from: a model on this device, the provider's, or typed by hand. */
  source: z.enum(["device", "provider", "typed"]).optional(),
});
export type ClipTranscript = z.infer<typeof transcriptSchema>;

/** A recorded file: where it is stored, and where it starts on the clip's clock. */
export const mediaSchema = z.object({
  key: z.string(),
  type: z.string(),
  /** Seconds after the screen recording started (the camera and the microphone open later). */
  offset: z.number().default(0),
  duration: z.number().default(0),
  width: z.number().default(0),
  height: z.number().default(0),
  /** The file holds sound (the screen's: a tab's or the system's). */
  audio: z.boolean().default(false),
});
export type Media = z.infer<typeof mediaSchema>;

/** A moment the screen changed: where, and how much of it (for zooms). */
export const activitySchema = z.object({ t: z.number(), box: boxSchema, ratio: z.number() });
export type Activity = z.infer<typeof activitySchema>;

/** A piece of a voice-over: the file's sound from `at` laid on [start, end) of the take's clock. */
export const voiceoverPieceSchema = z.object({
  key: z.string(),
  type: z.string(),
  start: z.number(),
  end: z.number(),
  at: z.number(),
});
export type VoiceoverPiece = z.infer<typeof voiceoverPieceSchema>;

/** What is heard of a take: the voice recorded with it, nothing, or a voice-over. */
export const VOICES = ["take", "none", "over"] as const;
export type Voice = (typeof VOICES)[number];

export const clipSchema = z.object({
  id: z.string(),
  createdAt: z.number().default(0),
  /** Length of the take, in seconds. */
  duration: z.number(),
  screen: mediaSchema.nullable().default(null),
  camera: mediaSchema.nullable().default(null),
  mic: mediaSchema.nullable().default(null),
  activity: z.array(activitySchema).default([]),
  /** Key of a still of the take, for lists. */
  poster: z.string().nullable().default(null),
  /**
   * The text of the voice heard, on the clip's clock (the microphone's offset already added):
   * the voice-over's when it is heard and transcribed, else `takeTranscript`.
   */
  transcript: transcriptSchema.nullable().default(null),
  /** What was said (or typed) with the take, kept while a voice-over's text is shown. */
  takeTranscript: transcriptSchema.nullable().default(null),
  voice: z.enum(VOICES).default("take"),
  /** A voice recorded afterwards, over the edited video, and its text. */
  voiceover: z
    .object({
      pieces: z.array(voiceoverPieceSchema).default([]),
      transcript: transcriptSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type Clip = z.infer<typeof clipSchema>;

/** The clip with `transcript` following the voice heard. */
function shown(c: Clip): Clip {
  const over = c.voice === "over" ? c.voiceover?.transcript : null;
  return { ...c, transcript: over ?? c.takeTranscript };
}

/** The clip with another voice heard, and its text shown. */
export function withVoice(c: Clip, voice: Voice): Clip {
  return shown({ ...c, voice });
}

/** The clip with a new text for the take's voice or for the voice-over. */
export function withTranscript(c: Clip, of: "take" | "over", t: ClipTranscript | null): Clip {
  if (of === "take") return shown({ ...c, takeTranscript: t });
  return shown({ ...c, voiceover: { pieces: c.voiceover?.pieces ?? [], transcript: t } });
}

/** Which text is shown: the voice-over's or the take's. */
export function shownOf(c: Clip): "take" | "over" {
  return c.voice === "over" && c.voiceover?.transcript ? "over" : "take";
}

/** A range on a clip's clock. */
const rangeSchema = z.object({
  id: z.string(),
  clip: z.string(),
  start: z.number(),
  end: z.number(),
});

export const CUT_REASONS = ["manual", "text", "filler", "silence", "retake", "trim"] as const;
export const cutSchema = rangeSchema.extend({ reason: z.enum(CUT_REASONS).default("manual") });
export type Cut = z.infer<typeof cutSchema>;

export const LAYOUTS = ["bubble", "screen", "camera", "side"] as const;
export type LayoutKind = (typeof LAYOUTS)[number];
/** `auto`: placed by the AI edit (or suggested), replaced when it runs again. */
export const layoutSchema = rangeSchema.extend({
  layout: z.enum(LAYOUTS),
  auto: z.boolean().default(false),
});
export type LayoutRange = z.infer<typeof layoutSchema>;

/** A zoom on the screen: `box` is the region shown, normalized to the screen. */
export const zoomSchema = rangeSchema.extend({ box: boxSchema, auto: z.boolean().default(false) });
export type Zoom = z.infer<typeof zoomSchema>;

/** A region of the screen blurred while it is shown. */
export const blurSchema = rangeSchema.extend({ box: boxSchema, auto: z.boolean().default(false) });
export type Blur = z.infer<typeof blurSchema>;

export const ASPECTS = ["16:9", "9:16", "1:1", "4:3"] as const;
export type Aspect = (typeof ASPECTS)[number];
export const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;
export type Corner = (typeof CORNERS)[number];

export const styleSchema = z.object({
  aspect: z.enum(ASPECTS).default("16:9"),
  /** A gradient name, a CSS color, or "none". */
  background: z.string().default("ember"),
  /** Space around the screen, a fraction of the output's shorter side. */
  padding: z.number().default(0.05),
  /** Corner radius of the screen and the camera, a fraction of the output's shorter side. */
  radius: z.number().default(0.018),
  shadow: z.boolean().default(true),
  /** The layout wherever no range says otherwise. */
  layout: z.enum(LAYOUTS).default("bubble"),
  bubble: z
    .object({
      corner: z.enum(CORNERS).default("bottom-right"),
      /** Diameter, a fraction of the output's shorter side. */
      size: z.number().default(0.26),
      shape: z.enum(["circle", "rounded"]).default("circle"),
      mirror: z.boolean().default(true),
    })
    .prefault({}),
  captions: z
    .object({
      enabled: z.boolean().default(false),
      /** Text size, a fraction of the output's shorter side. */
      size: z.number().default(0.045),
      position: z.enum(["bottom", "top"]).default("bottom"),
      /** Highlight each word as it is said. */
      karaoke: z.boolean().default(true),
      /** The language shown: null for the original, else a code of `translations`. */
      language: z.string().nullable().default(null),
    })
    .prefault({}),
  audio: z
    .object({
      denoise: z.boolean().default(true),
      normalize: z.boolean().default(true),
      /** Gain of the screen's own sound against the voice, 0–1. */
      screenVolume: z.number().default(0.6),
    })
    .prefault({}),
});
export type Style = z.infer<typeof styleSchema>;

export const chapterSchema = z.object({
  id: z.string(),
  clip: z.string(),
  t: z.number(),
  title: z.string(),
});
export type Chapter = z.infer<typeof chapterSchema>;

export const projectSchema = z.object({
  version: z.literal(PROJECT_VERSION).default(PROJECT_VERSION),
  id: z.string(),
  title: z.string().default("Untitled video"),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
  /** The takes, in the order the video plays them. */
  clips: z.array(clipSchema).default([]),
  cuts: z.array(cutSchema).default([]),
  layouts: z.array(layoutSchema).default([]),
  zooms: z.array(zoomSchema).default([]),
  blurs: z.array(blurSchema).default([]),
  style: styleSchema.prefault({}),
  chapters: z.array(chapterSchema).default([]),
  /** Captions in other languages: segments on the clips' clocks, by language code. */
  translations: z.record(z.string(), z.array(pieceSchema.extend({ clip: z.string() }))).default({}),
  meta: z
    .object({
      summary: z.string().default(""),
      description: z.string().default(""),
      posts: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
});
export type Project = z.infer<typeof projectSchema>;

export type ParseResult = { ok: true; project: Project } | { ok: false; error: string };

export function parseProject(input: unknown): ParseResult {
  const res = projectSchema.safeParse(input);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "invalid project"}` };
  }
  // Projects from before voice-overs kept the take's text in `transcript` alone.
  const clips = res.data.clips.map((c) =>
    c.takeTranscript || !c.transcript || shownOf(c) === "over"
      ? c
      : { ...c, takeTranscript: c.transcript },
  );
  return { ok: true, project: { ...res.data, clips } };
}

let counter = 0;
export function newId(prefix = "x"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyProject(title = "Untitled video"): Project {
  const now = Date.now();
  const res = parseProject({ id: newId("p"), title, createdAt: now, updatedAt: now });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

/** Total length of the takes, before any cut. */
export function rawDuration(p: Project): number {
  return p.clips.reduce((s, c) => s + c.duration, 0);
}
