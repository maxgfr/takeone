/**
 * The author's live share panel: starts hosting the exported video, shows
 * the link to send, whether the relays and trackers are reachable, and a live
 * table of viewers (how far each got, where they are or left, how long they
 * watched, their reactions). Closing it, or closing the tab, ends the link.
 * The editor's Share menu opens it (inside a Modal or a side sheet).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  formatBytes,
  formatTime,
  type HostHandle,
  type HostStatus,
  hostVideo,
  summarize,
  type TransportStatus,
  type VideoMeta,
  type ViewerState,
  viewerLabel,
} from "../share/p2p";
import { Button, copyText, errorText, IconButton, toast } from "./ui";

function appUrl(): string {
  return location.href.split("#")[0] ?? location.href;
}

function StatePill({ status, error }: { status: HostStatus | null; error: string | null }) {
  const [cls, text] = error
    ? ["is-error", "Not shared"]
    : !status || status.state === "starting"
      ? ["is-pending", "Connecting…"]
      : status.state === "online"
        ? [
            "is-live",
            status.viewers === 1 ? "Live · 1 watching" : `Live · ${status.viewers} watching`,
          ]
        : status.state === "stopped"
          ? ["is-off", "Stopped"]
          : ["is-error", "Offline"];
  return (
    <span class={`pill ${cls}`} data-testid="live-state">
      <span class="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function Endpoints({ signaling }: { signaling: TransportStatus[] }) {
  const names = { nostr: "Nostr relays", torrent: "WebTorrent trackers" } as const;
  return (
    <details class="live-endpoints">
      <summary>
        Relays and trackers{" "}
        <span class="muted small">
          (
          {signaling.reduce(
            (n, t) => n + t.endpoints.filter((e) => e.state === "online").length,
            0,
          )}{" "}
          of {signaling.reduce((n, t) => n + t.endpoints.length, 0)} reachable)
        </span>
      </summary>
      {signaling.map((t) => (
        <div key={t.name}>
          <h3 class="field-label">{names[t.name]}</h3>
          <ul>
            {t.endpoints.map((e) => (
              <li key={e.url} class={`endpoint is-${e.state}`}>
                <span class="dot" aria-hidden="true" />
                <span class="mono">{e.url.replace(/^wss?:\/\//, "")}</span>
                <span class="muted small">
                  {e.state}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

function where(v: ViewerState, size: number): string {
  if (!v.connected) return `Left at ${formatTime(v.position)}`;
  if (v.downloaded < size)
    return `Downloading ${size > 0 ? Math.floor((v.downloaded / size) * 100) : 0}%`;
  return `${v.playing ? "Playing" : "Paused"} at ${formatTime(v.position)}`;
}

function ViewerRow({
  v,
  viewers,
  meta,
}: {
  v: ViewerState;
  viewers: ViewerState[];
  meta: VideoMeta;
}) {
  const reach = meta.duration > 0 ? Math.min(1, v.furthest / meta.duration) : 0;
  return (
    <tr class={v.connected ? "" : "is-gone"} data-testid="viewer-row">
      <th scope="row">
        <span class={`dot ${v.connected ? "is-online" : "is-off"}`} aria-hidden="true" />
        {viewerLabel(viewers, v)}
        <span class="sr-only">{v.connected ? " (watching)" : " (left)"}</span>
      </th>
      <td>
        <div
          class="reach"
          role="img"
          aria-label={`Reached ${formatTime(v.furthest)} of ${formatTime(meta.duration)}`}
        >
          <span style={{ width: `${(reach * 100).toFixed(1)}%` }} />
        </div>
      </td>
      <td class="small">{where(v, meta.size)}</td>
      <td class="small mono">{formatTime(v.watched)}</td>
      <td class="reactions-cell">
        {v.reactions.slice(-8).map((r) => (
          <span key={`${r.ts}-${r.emoji}`} title={`At ${formatTime(r.at)}`}>
            {r.emoji}
          </span>
        ))}
        {v.reactions.length > 8 && <span class="muted small"> +{v.reactions.length - 8}</span>}
      </td>
    </tr>
  );
}

export function LivePanel({
  file,
  meta,
  onClose,
}: {
  file: Blob;
  meta: VideoMeta;
  onClose: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [viewers, setViewers] = useState<ViewerState[]>([]);
  const [error, setError] = useState<string | null>(null);
  // One link per file: a new meta object from the parent must not restart the share.
  const shared = useRef(meta);

  useEffect(() => {
    let handle: HostHandle | null = null;
    let cancelled = false;
    const meta = shared.current;
    hostVideo({ file, meta, appUrl: appUrl(), onViewers: setViewers, onStatus: setStatus })
      .then((h) => {
        if (cancelled) h.stop();
        else {
          handle = h;
          setLink(h.link);
        }
      })
      .catch((err) => setError(errorText(err)));
    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, [file]);

  const copy = async () => {
    if (link && (await copyText(link))) toast("Link copied.", "success");
    else toast("Could not copy: select the link and copy it by hand.", "error");
  };

  const sorted = [...viewers].sort((a, b) => a.joinedAt - b.joinedAt);
  const sum = summarize(viewers, meta.duration);

  return (
    <section class="live-panel" aria-labelledby="live-title">
      <header class="live-head">
        <div>
          <h2 id="live-title">Live link</h2>
          <StatePill status={status} error={error} />
        </div>
        <IconButton icon="close" label="Stop sharing and close" onClick={onClose} />
      </header>

      {error ? (
        <p class="error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <div class="live-link">
            <input
              class="input mono"
              readOnly
              value={link ?? "Creating the link…"}
              aria-label="Share link"
              data-testid="live-link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="primary" icon="copy" disabled={!link} onClick={copy}>
              Copy
            </Button>
          </div>
          <p class="muted small">
            Viewers download {formatBytes(meta.size)} straight from this tab. Keep it open while
            people watch: the link stops working when you close it.
          </p>
          {status && <Endpoints signaling={status.signaling} />}
        </>
      )}

      <div class="live-viewers">
        <h3>
          Viewers{" "}
          {viewers.length > 0 && (
            <span class="muted small">
              {sum.watching} watching · {sum.total} in all · {sum.finished} reached the end
            </span>
          )}
        </h3>
        {viewers.length === 0 ? (
          <p class="muted small">No one yet. Viewers appear here as soon as they open the link.</p>
        ) : (
          <div class="table-scroll">
            <table class="live-table" data-testid="live-viewers">
              <thead>
                <tr>
                  <th scope="col">Viewer</th>
                  <th scope="col">Reached</th>
                  <th scope="col">Now</th>
                  <th scope="col">Watched</th>
                  <th scope="col">Reactions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((v) => (
                  <ViewerRow key={v.id} v={v} viewers={sorted} meta={meta} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
