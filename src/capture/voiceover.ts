/**
 * Recording a voice-over: the microphone into its own file while the edited
 * video plays, the takes' own voices silent. When it stops, the file is made
 * seekable and cut into pieces, each laid on the range of a take that was
 * playing while it was said (see edit/voiceover).
 */
import { type Media, newId } from "../model/project";
import { mediaWriter } from "../model/store";
import { finalizeMedia } from "./finalize";
import { openMic, TrackRecorder } from "./media";

export class VoiceoverRecording {
  private constructor(
    private readonly projectId: string,
    private readonly key: string,
    private readonly rec: TrackRecorder,
  ) {}

  /** Asks for the microphone (`deviceId` "" or null for the default one). */
  static async open(projectId: string, deviceId: string | null): Promise<VoiceoverRecording> {
    const stream = await openMic(deviceId || null);
    const key = newId("vo");
    try {
      const writer = await mediaWriter(projectId, key);
      return new VoiceoverRecording(
        projectId,
        key,
        new TrackRecorder(stream, writer, "audio", { audio: 128_000 }),
      );
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  get stream(): MediaStream {
    return this.rec.stream;
  }

  /** Starts recording; resolves with performance.now() when the file really starts. */
  async start(): Promise<number> {
    await this.rec.start();
    return this.rec.startedAt;
  }

  /** Stops, and gives the file, seekable. */
  async stop(): Promise<Media> {
    const seconds = (performance.now() - this.rec.startedAt) / 1000;
    await this.rec.stop();
    return finalizeMedia(this.projectId, {
      key: this.key,
      type: this.rec.type,
      offset: 0,
      duration: seconds,
      width: 0,
      height: 0,
      audio: true,
    });
  }

  abort(): Promise<void> {
    return this.rec.abort();
  }
}
