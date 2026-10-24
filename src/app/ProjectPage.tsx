/**
 * A project's takes, each source playable on its own. The editor replaces
 * this page; it already lets you check a take, add one, or delete one.
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Clip, Media, Project } from "../model/project";
import { deleteMedia, getMedia, getProject, saveProject } from "../model/store";
import { clock } from "./Record";
import { navigate } from "./router";
import { Button, IconButton, toast } from "./ui";

function Source({ projectId, media, label }: { projectId: string; media: Media; label: string }) {
  const url = useSignal("");
  useEffect(() => {
    let made = "";
    void getMedia(projectId, media.key, media.type.split(";")[0]).then((b) => {
      if (b) url.value = made = URL.createObjectURL(b);
    });
    return () => made && URL.revokeObjectURL(made);
  }, [media.key]);
  const audioOnly = label === "Microphone";
  return (
    <figure class="take-source">
      <figcaption>
        {label}
        {media.offset > 0 ? ` · starts at +${media.offset.toFixed(2)} s` : ""}
      </figcaption>
      {url.value &&
        (audioOnly ? (
          <audio controls src={url.value} aria-label={label} />
        ) : (
          <video controls src={url.value} aria-label={label} />
        ))}
    </figure>
  );
}

function Take({
  project,
  clip,
  index,
  onDelete,
}: {
  project: Project;
  clip: Clip;
  index: number;
  onDelete: () => void;
}) {
  return (
    <article class="take">
      <header class="take-head">
        <h2>
          Take {index + 1} · {clock(clip.duration)}
        </h2>
        <span class="muted small">{clip.activity.length} moments of activity on screen</span>
        <IconButton icon="trash" label={`Delete take ${index + 1}`} onClick={onDelete} />
      </header>
      <div class="take-sources">
        {clip.screen && <Source projectId={project.id} media={clip.screen} label="Screen" />}
        {clip.camera && <Source projectId={project.id} media={clip.camera} label="Camera" />}
        {clip.mic && <Source projectId={project.id} media={clip.mic} label="Microphone" />}
      </div>
    </article>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const project = useSignal<Project | null | undefined>(undefined);
  useEffect(() => {
    void getProject(id).then((p) => (project.value = p));
  }, [id]);
  const p = project.value;
  if (p === undefined) return <main class="page" />;
  if (p === null)
    return (
      <main class="page">
        <p>This project is not on this device.</p>
        <Button onClick={() => navigate("#/")}>Home</Button>
      </main>
    );

  const removeTake = async (clip: Clip) => {
    if (!confirm("Delete this take and its files?")) return;
    for (const m of [clip.screen, clip.camera, clip.mic]) if (m) await deleteMedia(p.id, m.key);
    if (clip.poster) await deleteMedia(p.id, clip.poster);
    const next = { ...p, clips: p.clips.filter((c) => c.id !== clip.id) };
    await saveProject(next);
    project.value = next;
    toast("Take deleted.");
  };

  return (
    <main class="page">
      <header class="page-head">
        <h1>{p.title}</h1>
        <Button
          variant="primary"
          icon="record"
          onClick={() => navigate(`#/record?project=${p.id}`)}
        >
          Record another take
        </Button>
      </header>
      {p.clips.length === 0 && <p class="muted">No take yet.</p>}
      {p.clips.map((c, i) => (
        <Take key={c.id} project={p} clip={c} index={i} onDelete={() => void removeTake(c)} />
      ))}
    </main>
  );
}
