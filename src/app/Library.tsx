/** Your recordings, on the home page: newest first, each with a still and its length. */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { type Project, rawDuration } from "../model/project";
import { deleteProject, getMedia, listProjects } from "../model/store";
import { clock } from "./Record";
import { navigate } from "./router";
import { Icon, IconButton, toast } from "./ui";

function Poster({ project }: { project: Project }) {
  const url = useSignal("");
  useEffect(() => {
    const key = project.clips.find((c) => c.poster)?.poster;
    let made = "";
    if (key)
      void getMedia(project.id, key, "image/webp").then((b) => {
        if (b) url.value = made = URL.createObjectURL(b);
      });
    return () => made && URL.revokeObjectURL(made);
  }, [project.id]);
  return url.value ? (
    <img class="lib-poster" src={url.value} alt="" />
  ) : (
    <div class="lib-poster lib-poster-empty" aria-hidden="true">
      <Icon name="video" size={22} />
    </div>
  );
}

export function Library() {
  const projects = useSignal<Project[] | null>(null);
  const refresh = () =>
    void listProjects()
      .then((p) => (projects.value = p))
      .catch(() => (projects.value = []));
  useEffect(refresh, []);

  const remove = async (p: Project) => {
    if (!confirm(`Delete "${p.title}" and its recordings from this device?`)) return;
    await deleteProject(p.id);
    toast("Deleted.");
    refresh();
  };

  const list = projects.value;
  if (!list) return null;
  return (
    <section class="library" aria-label="Your recordings">
      <h2>Your recordings</h2>
      {list.length === 0 ? (
        <p class="muted">Nothing recorded yet. Your takes stay on this device.</p>
      ) : (
        <ul class="lib-grid">
          {list.map((p) => (
            <li key={p.id} class="lib-item">
              <button type="button" class="lib-open" onClick={() => navigate(`#/edit/${p.id}`)}>
                <Poster project={p} />
                <span class="lib-title">{p.title}</span>
                <span class="lib-meta">
                  {clock(rawDuration(p))} · {p.clips.length} take{p.clips.length === 1 ? "" : "s"} ·{" "}
                  {new Date(p.updatedAt).toLocaleDateString()}
                </span>
              </button>
              <IconButton icon="trash" label={`Delete ${p.title}`} onClick={() => void remove(p)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
