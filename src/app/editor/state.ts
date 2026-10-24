/**
 * The open project: one signal, edits saved shortly after they happen, and an
 * undo history. The history keeps the edit only (cuts, layouts, zooms, blurs,
 * style, order of the takes, texts), not the takes' recorded data, so a
 * hundred steps of undo stay small.
 */
import { batch, computed, signal } from "@preact/signals";
import { outputDuration, type Segment, segmentsOf } from "../../edit/timeline";
import type { Clip, Project } from "../../model/project";
import { getMedia, getProject, saveProject } from "../../model/store";

export const project = signal<Project | null>(null);
export const saveError = signal<string | null>(null);

/** What a selection in the editor points at. */
export type Selection =
  | { kind: "zoom"; id: string }
  | { kind: "layout"; id: string }
  | { kind: "blur"; id: string }
  | { kind: "cut"; id: string }
  | null;
export const selection = signal<Selection>(null);

export const segments = computed<Segment[]>(() => (project.value ? segmentsOf(project.value) : []));
export const duration = computed(() => outputDuration(segments.value));

type Edit = Omit<Project, "clips"> & { order: string[] };

function editOf(p: Project): Edit {
  const { clips, ...rest } = p;
  return { ...rest, order: clips.map((c) => c.id) };
}

function withEdit(p: Project, e: Edit): Project {
  const { order, ...rest } = e;
  const byId = new Map(p.clips.map((c) => [c.id, c]));
  const clips = order.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
  return { ...rest, clips };
}

const undoStack: Edit[] = [];
const redoStack: Edit[] = [];
export const history = signal({ undo: 0, redo: 0 });
let lastAt = 0;
let lastTag = "";

const urls = new Map<string, string>();

export async function openProject(id: string): Promise<boolean> {
  if (project.value?.id === id) return true;
  closeProject();
  const p = await getProject(id);
  project.value = p;
  return p !== null;
}

export function closeProject(): void {
  void flushSave();
  project.value = null;
  selection.value = null;
  undoStack.length = 0;
  redoStack.length = 0;
  history.value = { undo: 0, redo: 0 };
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
}

/** An object URL for one of the open project's media files. */
export async function mediaUrl(key: string, type: string): Promise<string> {
  const p = project.value;
  if (!p) return "";
  const cached = urls.get(key);
  if (cached) return cached;
  const blob = await getMedia(p.id, key, type.split(";")[0]);
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 500);
}

export async function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  const p = project.value;
  if (!p) return;
  try {
    await saveProject(p);
    saveError.value = null;
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : "Could not save";
  }
}

/**
 * Changes the project. Edits with the same `tag` within a second merge into one undo step, so
 * dragging a slider or typing a title is undone at once.
 */
export function update(fn: (p: Project) => Project, tag = ""): void {
  const p = project.value;
  if (!p) return;
  const now = Date.now();
  if (!tag || tag !== lastTag || now - lastAt > 1000) {
    undoStack.push(editOf(p));
    if (undoStack.length > 150) undoStack.shift();
  }
  lastAt = now;
  lastTag = tag;
  redoStack.length = 0;
  history.value = { undo: undoStack.length, redo: 0 };
  project.value = fn(p);
  scheduleSave();
}

/** Changes a take's recorded data (its transcript, say): saved, but not an undo step. */
export function updateClip(id: string, fn: (c: Clip) => Clip): void {
  const p = project.value;
  if (!p) return;
  project.value = { ...p, clips: p.clips.map((c) => (c.id === id ? fn(c) : c)) };
  scheduleSave();
}

export function undo(): void {
  const p = project.value;
  const prev = undoStack.pop();
  if (!p || !prev) return;
  redoStack.push(editOf(p));
  lastTag = "";
  batch(() => {
    history.value = { undo: undoStack.length, redo: redoStack.length };
    project.value = withEdit(p, prev);
  });
  scheduleSave();
}

export function redo(): void {
  const p = project.value;
  const next = redoStack.pop();
  if (!p || !next) return;
  undoStack.push(editOf(p));
  lastTag = "";
  batch(() => {
    history.value = { undo: undoStack.length, redo: redoStack.length };
    project.value = withEdit(p, next);
  });
  scheduleSave();
}
