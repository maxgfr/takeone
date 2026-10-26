/**
 * Recording a voice-over in the editor: from the playhead, the edited video
 * plays with the takes' voices silent while the microphone records; the
 * transcript highlights what was said there, as a prompter. It stops at the
 * end of the video, on Stop, or when playback is paused. The takes it covers
 * then play the voice-over, and their new text is transcribed.
 */
import { signal } from "@preact/signals";
import { VoiceoverRecording } from "../../capture/voiceover";
import type { PreviewEngine } from "../../edit/preview";
import type { Segment } from "../../edit/timeline";
import { layPieces, voiceoverPieces } from "../../edit/voiceover";
import { withVoice } from "../../model/project";
import { chosenMic, clock } from "../Record";
import { Button, errorText, toast } from "../ui";
import { project, segments, updateClip } from "./state";
import { transcribeTake } from "./transcription";

type Status = "idle" | "opening" | "countdown" | "recording" | "saving";

/** Where the voice-over is; the editor is locked while it is not idle. */
export const dubbing = signal<Status>("idle");
const count = signal(3);
const elapsed = signal(0);

let current: {
  rec: VoiceoverRecording;
  engine: PreviewEngine;
  t0: number;
  lag: number;
  segments: Segment[];
  unsubscribe: () => void;
} | null = null;

async function finish(): Promise<void> {
  const c = current;
  if (!c || dubbing.value !== "recording") return;
  current = null;
  dubbing.value = "saving";
  c.unsubscribe();
  const t1 = c.engine.time.peek();
  c.engine.pause();
  c.engine.voicesMuted = false;
  try {
    const media = await c.rec.stop();
    const placed = voiceoverPieces(c.segments, c.t0, t1, c.lag, {
      key: media.key,
      type: media.type,
    });
    if (placed.length === 0) {
      toast("That voice-over was too short to keep.", "error");
      return;
    }
    const takes = [...new Set(placed.map((x) => x.clip))];
    for (const id of takes) {
      const fresh = placed.filter((x) => x.clip === id).map((x) => x.piece);
      updateClip(id, (clip) =>
        withVoice(
          {
            ...clip,
            voiceover: {
              pieces: layPieces(clip.voiceover?.pieces ?? [], fresh),
              transcript: clip.voiceover?.transcript ?? null,
            },
          },
          "over",
        ),
      );
    }
    c.engine.seek(c.t0);
    toast(`Voice-over recorded over ${clock(t1 - c.t0)}. Transcribing it…`, "success");
    for (const id of takes) if (!(await transcribeTake(id, "over"))) break;
  } catch (err) {
    toast(errorText(err), "error", 8000);
  } finally {
    dubbing.value = "idle";
  }
}

async function begin(engine: PreviewEngine): Promise<void> {
  const p = project.value;
  if (!p || dubbing.value !== "idle") return;
  dubbing.value = "opening";
  let rec: VoiceoverRecording | null = null;
  try {
    rec = await VoiceoverRecording.open(p.id, chosenMic());
    engine.pause();
    dubbing.value = "countdown";
    for (let n = 3; n > 0; n--) {
      count.value = n;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const t0 = engine.time.peek() >= engine.length - 0.1 ? 0 : engine.time.peek();
    engine.seek(t0);
    engine.voicesMuted = true;
    const startedAt = await rec.start();
    engine.play();
    const lag = Math.max(0, (performance.now() - startedAt) / 1000);
    dubbing.value = "recording";
    elapsed.value = 0;
    const unsubscribe = engine.playing.subscribe((playing) => {
      if (!playing) void finish();
    });
    const tick = engine.time.subscribe((t) => (elapsed.value = t - t0));
    current = {
      rec,
      engine,
      t0,
      lag,
      segments: segments.peek(),
      unsubscribe: () => {
        unsubscribe();
        tick();
      },
    };
  } catch (err) {
    engine.voicesMuted = false;
    await rec?.abort().catch(() => undefined);
    const msg = errorText(err);
    toast(msg === "Permission was refused." ? "The microphone was not allowed." : msg, "error");
    dubbing.value = "idle";
  }
}

export function VoiceoverButton({ engine }: { engine: PreviewEngine | null }) {
  const s = dubbing.value;
  if (s === "recording")
    return (
      <Button variant="danger" icon="stop" onClick={() => engine?.pause()}>
        Stop voice-over · {clock(elapsed.value)}
      </Button>
    );
  const label =
    s === "opening"
      ? "Allow the microphone…"
      : s === "countdown"
        ? `Speak in ${count.value}…`
        : s === "saving"
          ? "Saving the voice-over…"
          : "Record voice-over";
  return (
    <Button
      icon="mic"
      disabled={!engine || s !== "idle" || !project.value?.clips.length}
      title="Speak over the edited video, from the playhead: the takes' voices are silent meanwhile"
      onClick={() => engine && void begin(engine)}
    >
      {label}
    </Button>
  );
}
