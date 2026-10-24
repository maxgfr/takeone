/**
 * Export and share: render the edit to a file in this tab (MP4 up to 4K at
 * 60 fps, WebM, GIF, the sound alone, one HTML page with the player, the
 * transcript), in its own format or as a vertical or square version, then
 * download it or share it as a live link that streams from this tab.
 */
import { signal, useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { outputDuration, segmentsOf } from "../../edit/timeline";
import { renderGif } from "../../export/gif";
import { exportHtml } from "../../export/html";
import { outputChapters, transcriptMarkdown } from "../../export/text";
import { renderAudio, renderVideo } from "../../export/video";
import type { Aspect } from "../../model/project";
import { LivePanel } from "../LivePanel";
import { clock } from "../Record";
import { Button, errorText, Field, Icon, type IconName, Modal, toast } from "../ui";
import { flushSave, project } from "./state";

type Kind = "mp4" | "webm" | "gif" | "audio" | "html" | "text";

const KINDS: { kind: Kind; icon: IconName; title: string; body: string }[] = [
  {
    kind: "mp4",
    icon: "video",
    title: "MP4 video",
    body: "Plays everywhere: H.264 + AAC, up to 4K at 60 fps.",
  },
  {
    kind: "html",
    icon: "file",
    title: "HTML page",
    body: "One file with the video, chapters, captions and transcript.",
  },
  {
    kind: "webm",
    icon: "video",
    title: "WebM video",
    body: "VP9 + Opus, smaller files for the web.",
  },
  { kind: "gif", icon: "image", title: "GIF", body: "No sound, for docs, issues and chat." },
  { kind: "audio", icon: "mic", title: "Sound only", body: "The cleaned-up voice as an M4A file." },
  {
    kind: "text",
    icon: "text",
    title: "Transcript",
    body: "Markdown with chapters and timestamps.",
  },
];

const SIDES = [
  { side: 720, label: "720p" },
  { side: 1080, label: "1080p" },
  { side: 1440, label: "1440p" },
  { side: 2160, label: "4K" },
];

/** The last video rendered in this session, to share without rendering again. */
const lastVideo = signal<{ blob: Blob; key: string } | null>(null);

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function fileName(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 60);
  return `${slug || "takeone"}.${ext}`;
}

export function ExportPanel({ onClose }: { onClose: () => void }) {
  const p = project.value;
  const kind = useSignal<Kind>("mp4");
  const side = useSignal(1080);
  const fps = useSignal<30 | 60>(30);
  const aspect = useSignal<Aspect | "project">("project");
  const busy = useSignal<{ ratio: number; label: string } | null>(null);
  const sharing = useSignal(false);
  const abort = useRef<AbortController | null>(null);
  if (!p) return null;
  const duration = outputDuration(segmentsOf(p));
  const video = kind.value === "mp4" || kind.value === "webm" || kind.value === "html";
  const settingsKey = JSON.stringify([p.updatedAt, side.value, fps.value, aspect.value]);

  const run = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    busy.value = { ratio: 0, label: "Preparing…" };
    const onProgress = (ratio: number, label: string) => (busy.value = { ratio, label });
    const format = aspect.value === "project" ? undefined : aspect.value;
    try {
      await flushSave();
      const current = project.value ?? p;
      switch (kind.value) {
        case "text":
          download(
            new Blob([transcriptMarkdown(current)], { type: "text/markdown" }),
            fileName(current.title, "md"),
          );
          break;
        case "audio": {
          const blob = await renderAudio(current, onProgress, ctrl.signal);
          download(blob, fileName(current.title, blob.type === "audio/mp4" ? "m4a" : "webm"));
          break;
        }
        case "gif": {
          const blob = await renderGif(current, {
            side: Math.min(side.value, 540),
            fps: 12,
            ...(format ? { aspect: format } : {}),
            onProgress,
            signal: ctrl.signal,
          });
          download(blob, fileName(current.title, "gif"));
          break;
        }
        default: {
          const container = kind.value === "webm" ? "webm" : "mp4";
          const blob = await renderVideo(current, {
            container,
            side: side.value,
            fps: fps.value,
            ...(format ? { aspect: format } : {}),
            onProgress,
            signal: ctrl.signal,
          });
          lastVideo.value = { blob, key: settingsKey };
          if (kind.value === "html") {
            busy.value = { ratio: 1, label: "Writing the page…" };
            download(await exportHtml(current, blob), fileName(current.title, "html"));
          } else download(blob, fileName(current.title, container));
        }
      }
      toast("Exported.", "success");
    } catch (err) {
      toast(errorText(err), "error", 8000);
    } finally {
      busy.value = null;
      abort.current = null;
    }
  };

  const share = lastVideo.value;
  if (sharing.value && share)
    return (
      <Modal title="Share a live link" onClose={() => (sharing.value = false)} wide>
        <LivePanel
          file={share.blob}
          meta={{
            title: p.title,
            duration,
            type: share.blob.type,
            size: share.blob.size,
            chapters: outputChapters(p),
          }}
          onClose={() => (sharing.value = false)}
        />
      </Modal>
    );

  return (
    <Modal
      title="Export and share"
      onClose={() => (busy.value ? abort.current?.abort() : onClose())}
      wide
    >
      <div class="export">
        <div class="export-kinds">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={kind.value === k.kind}
              class={`export-kind ${kind.value === k.kind ? "is-on" : ""}`}
              disabled={!!busy.value}
              onClick={() => (kind.value = k.kind)}
            >
              <Icon name={k.icon} size={18} />
              <strong>{k.title}</strong>
              <span>{k.body}</span>
            </button>
          ))}
        </div>
        {kind.value !== "text" && kind.value !== "audio" && (
          <div class="grid-3">
            <Field label="Shape">
              <select
                class="input"
                value={aspect.value}
                onChange={(e) => (aspect.value = e.currentTarget.value as Aspect | "project")}
              >
                <option value="project">As edited ({p.style.aspect})</option>
                <option value="16:9">16:9 landscape</option>
                <option value="9:16">9:16 vertical (Shorts, Reels, TikTok)</option>
                <option value="1:1">1:1 square</option>
              </select>
            </Field>
            {kind.value !== "gif" && (
              <>
                <Field label="Resolution">
                  <select
                    class="input"
                    value={side.value}
                    onChange={(e) => (side.value = Number(e.currentTarget.value))}
                  >
                    {SIDES.map((s) => (
                      <option key={s.side} value={s.side}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Frame rate">
                  <select
                    class="input"
                    value={fps.value}
                    onChange={(e) => (fps.value = Number(e.currentTarget.value) === 60 ? 60 : 30)}
                  >
                    <option value={30}>30 fps</option>
                    <option value={60}>60 fps</option>
                  </select>
                </Field>
              </>
            )}
          </div>
        )}
        <p class="muted small">
          {clock(duration)} of video. Everything is rendered in this tab: nothing is uploaded.
          {video && side.value >= 2160 ? " 4K takes a while: keep this tab in front." : ""}
        </p>
        {busy.value ? (
          <div class="busy">
            <div class="spinner" aria-hidden="true" />
            <span>{busy.value.label}</span>
            <progress max={1} value={busy.value.ratio} />
            <Button size="sm" onClick={() => abort.current?.abort()}>
              Cancel
            </Button>
          </div>
        ) : (
          <div class="modal-actions">
            {share && (
              <Button icon="share" onClick={() => (sharing.value = true)}>
                Share the last video live
              </Button>
            )}
            <Button
              variant="primary"
              icon="download"
              disabled={duration <= 0}
              onClick={() => void run()}
            >
              Export
            </Button>
          </div>
        )}
        <p class="muted small">
          <Icon name="share" size={13} /> A live link streams the video from this tab to whoever
          opens it, peer to peer, and shows you who watches. It works while this tab stays open.
        </p>
      </div>
    </Modal>
  );
}
