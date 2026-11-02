/**
 * Storage on this device. A project's JSON lives in IndexedDB and is rewritten
 * on every edit; its media (minutes of video) live in the Origin Private File
 * System, written chunk by chunk while recording so a long take never sits in
 * memory, under `takeone/projects/<id>/<key>`. Without OPFS, media fall back to
 * IndexedDB blobs.
 *
 * The origin (maxgfr.github.io) is shared by every project page, and so are its
 * OPFS root and its quota: our files live under a `takeone` directory, and a
 * take that cannot be kept is deleted rather than left to fill the disk.
 */
import { type Project, parseProject } from "./project";

const DB_NAME = "takeone";
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects"))
        db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("IndexedDB is not available"));
    };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: "projects" | "media", mode: IDBTransactionMode = "readonly") {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

// --- Projects ---------------------------------------------------------------

export async function saveProject(p: Project): Promise<void> {
  await done((await store("projects", "readwrite")).put({ ...p, updatedAt: Date.now() }));
}

export async function getProject(id: string): Promise<Project | null> {
  const raw = await done((await store("projects")).get(id));
  if (!raw) return null;
  const res = parseProject(raw);
  return res.ok ? res.project : null;
}

/** Every project, the most recently edited first. */
export async function listProjects(): Promise<Project[]> {
  const all = (await done((await store("projects")).getAll())) as unknown[];
  return all
    .flatMap((raw) => {
      const res = parseProject(raw);
      return res.ok ? [res.project] : [];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await done((await store("projects", "readwrite")).delete(id));
  await done((await store("media", "readwrite")).delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`)));
  for (const projects of [await projectsDir(false), await legacyProjectsDir()]) {
    await projects?.removeEntry(id, { recursive: true }).catch(() => undefined);
  }
}

// --- Media --------------------------------------------------------------------

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await navigator.storage?.getDirectory?.()) ?? null;
  } catch {
    return null;
  }
}

const OPFS_DIR = "takeone";

/** `takeone/projects`, where every project's media lives. */
async function projectsDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await opfsRoot();
    const own = await root?.getDirectoryHandle(OPFS_DIR, { create });
    return (await own?.getDirectoryHandle("projects", { create })) ?? null;
  } catch {
    return null;
  }
}

async function projectDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await (await projectsDir(create))?.getDirectoryHandle(id, { create })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where media were kept before: `projects/` at the OPFS root, a name any site
 * of the origin may use. Only the folders of our own projects are read there.
 */
async function legacyProjectsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await (await opfsRoot())?.getDirectoryHandle("projects")) ?? null;
  } catch {
    return null;
  }
}

async function legacyProjectDir(id: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await (await legacyProjectsDir())?.getDirectoryHandle(id)) ?? null;
  } catch {
    return null;
  }
}

type Movable = FileSystemFileHandle & {
  move?: (dir: FileSystemDirectoryHandle) => Promise<void>;
};

/**
 * Moves our projects' media from `projects/<id>` to `takeone/projects/<id>`,
 * idempotent. Moves only (no copy: minutes of video, on a disk that may be
 * full); a file that cannot move (no `move()`, open in another tab) stays where
 * it is and is still read from there. Folders of other sites, and `projects/`
 * itself, are left alone.
 */
export async function migrateMedia(ids?: readonly string[]): Promise<void> {
  const legacy = await legacyProjectsDir();
  if (!legacy) return;
  const known = ids ?? (await listProjects()).map((p) => p.id);
  for (const id of known) {
    const from = await legacyProjectDir(id);
    if (!from) continue;
    const to = await projectDir(id, true);
    if (!to) return;
    const files: Movable[] = [];
    for await (const entry of from.values())
      if (entry.kind === "file") files.push(entry as Movable);
    for (const file of files) await file.move?.(to).catch(() => undefined);
    let empty = true;
    for await (const _ of from.keys()) empty = false;
    if (empty) await legacy.removeEntry(id).catch(() => undefined);
  }
}

/**
 * Removes the media folders of projects that no longer exist: a take whose tab
 * closed before it was kept. Only folders untouched for a day, so a take being
 * recorded in another tab is never removed.
 */
export async function sweepOrphanMedia(ids?: readonly string[], now = Date.now()): Promise<void> {
  const projects = await projectsDir(false);
  if (!projects) return;
  const known = new Set(ids ?? (await listProjects()).map((p) => p.id));
  const dirs: [string, FileSystemHandle][] = [];
  for await (const pair of projects.entries()) dirs.push(pair);
  for (const [id, entry] of dirs) {
    if (known.has(id) || entry.kind !== "directory") continue;
    let newest = 0;
    try {
      for await (const f of (entry as FileSystemDirectoryHandle).values()) {
        if (f.kind === "file")
          newest = Math.max(newest, (await (f as FileSystemFileHandle).getFile()).lastModified);
      }
    } catch {
      continue;
    }
    if (now - newest > ORPHAN_AGE_MS)
      await projects.removeEntry(id, { recursive: true }).catch(() => undefined);
  }
}
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

type Writable = FileSystemFileHandle & {
  createWritable?: () => Promise<FileSystemWritableFileStream>;
};

/** Appends chunks to one media file as they arrive; `close` resolves once it is all on disk. */
export interface MediaWriter {
  write(chunk: Blob): Promise<void>;
  close(type: string): Promise<void>;
  abort(): Promise<void>;
}

export async function mediaWriter(projectId: string, key: string): Promise<MediaWriter> {
  const dir = await projectDir(projectId, true);
  const handle = (await dir?.getFileHandle(key, { create: true })) as Writable | undefined;
  let stream: FileSystemWritableFileStream | null = null;
  try {
    stream = handle?.createWritable ? await handle.createWritable() : null;
  } catch (err) {
    await dir?.removeEntry(key).catch(() => undefined);
    throw err;
  }
  if (stream) {
    const s = stream;
    // Writes are queued: MediaRecorder hands chunks faster than a disk may take them.
    let queue = Promise.resolve();
    return {
      write: (chunk) => (queue = queue.then(() => s.write(chunk))),
      close: async () => {
        try {
          await queue;
          await s.close();
        } catch (err) {
          // Full or failed: let go of the file rather than keep it locked.
          await s.abort().catch(() => undefined);
          throw err;
        }
      },
      abort: async () => {
        await queue.catch(() => undefined);
        await s.abort().catch(() => undefined);
      },
    };
  }
  // No writable OPFS (older Safari): keep the chunks, store one blob at the end.
  const chunks: Blob[] = [];
  return {
    write: async (chunk) => {
      chunks.push(chunk);
    },
    close: async (type) => putMedia(projectId, key, new Blob(chunks, { type })),
    abort: async () => {
      chunks.length = 0;
    },
  };
}

export async function putMedia(projectId: string, key: string, blob: Blob): Promise<void> {
  const dir = await projectDir(projectId, true);
  const handle = (await dir?.getFileHandle(key, { create: true })) as Writable | undefined;
  if (handle?.createWritable) {
    const w = await handle.createWritable();
    try {
      await w.write(blob);
      await w.close();
    } catch (err) {
      await w.abort().catch(() => undefined);
      await dir?.removeEntry(key).catch(() => undefined);
      throw err;
    }
    return;
  }
  await done((await store("media", "readwrite")).put(blob, `${projectId}:${key}`));
}

/** A media file, typed: OPFS files carry no type of their own. */
export async function getMedia(projectId: string, key: string, type = ""): Promise<Blob | null> {
  for (const dir of [await projectDir(projectId, false), await legacyProjectDir(projectId)]) {
    if (!dir) continue;
    try {
      const file = await (await dir.getFileHandle(key)).getFile();
      return type && file.type !== type ? new Blob([file], { type }) : file;
    } catch {
      // Not there: maybe in the old place, or in IndexedDB.
    }
  }
  const blob = (await done((await store("media")).get(`${projectId}:${key}`))) as Blob | undefined;
  return blob ?? null;
}

export async function deleteMedia(projectId: string, key: string): Promise<void> {
  for (const dir of [await projectDir(projectId, false), await legacyProjectDir(projectId)]) {
    await dir?.removeEntry(key).catch(() => undefined);
  }
  await done((await store("media", "readwrite")).delete(`${projectId}:${key}`));
}

/** Bytes used and available for this site, when the browser says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const e = await navigator.storage?.estimate?.();
  return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
}
