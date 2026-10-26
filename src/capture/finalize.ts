/**
 * MediaRecorder writes WebM files as a live stream: no duration and no index
 * (cues), so a player has to scan the file to seek, which makes scrubbing an
 * edit slow. After a take, each file is remuxed by mediabunny (the encoded
 * frames copied as they are, nothing re-encoded) into a WebM with its
 * duration and its cues, written back to disk.
 */
import type { Clip, Media } from "../model/project";
import { deleteMedia, getMedia, mediaWriter } from "../model/store";

async function remux(projectId: string, media: Media): Promise<Media> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat } =
    await import("mediabunny");
  const blob = await getMedia(projectId, media.key, media.type.split(";")[0]);
  if (!blob) return media;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({ input, output });
  if (!conversion.isValid) return media;
  await conversion.execute();
  const duration = await input.computeDuration();
  const buffer = output.target.buffer;
  input.dispose();
  if (!buffer) return media;
  const type = media.type.startsWith("audio") ? "audio/webm" : "video/webm";
  const key = `${media.key}-r`;
  const writer = await mediaWriter(projectId, key);
  await writer.write(new Blob([buffer], { type }));
  await writer.close(type);
  await deleteMedia(projectId, media.key);
  return { ...media, key, type, duration: Number.isFinite(duration) ? duration : media.duration };
}

/** A file made seekable; one that cannot be remuxed is kept as it is. */
export async function finalizeMedia(projectId: string, m: Media): Promise<Media> {
  if (!m.type.includes("webm")) return m;
  try {
    return await remux(projectId, m);
  } catch (err) {
    console.warn("takeone: could not remux", m.key, err);
    return m;
  }
}

/** Each of the clip's files made seekable. */
export async function finalizeClip(projectId: string, clip: Clip): Promise<Clip> {
  const fix = async (m: Media | null) => (m ? finalizeMedia(projectId, m) : m);
  const [screen, camera, mic] = await Promise.all([
    fix(clip.screen),
    fix(clip.camera),
    fix(clip.mic),
  ]);
  return { ...clip, screen, camera, mic };
}
