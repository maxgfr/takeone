/**
 * Storage on this device. A project's JSON lives in IndexedDB and is rewritten
 * on every edit; its media (minutes of video) live in the Origin Private File
 * System, written chunk by chunk while recording so a long take never sits in
 * memory, under `projects/<id>/<key>`. Without OPFS, media fall back to
 * IndexedDB blobs.
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
  try {
    const projects = await (await opfsRoot())?.getDirectoryHandle("projects");
    await projects?.removeEntry(id, { recursive: true });
  } catch {
    // Nothing stored in OPFS for this project.
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

async function projectDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const projects = await root.getDirectoryHandle("projects", { create });
    return await projects.getDirectoryHandle(id, { create });
  } catch {
    return null;
  }
}

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
  const stream = handle?.createWritable ? await handle.createWritable() : null;
  if (stream) {
    // Writes are queued: MediaRecorder hands chunks faster than a disk may take them.
    let queue = Promise.resolve();
    return {
      write: (chunk) => (queue = queue.then(() => stream.write(chunk))),
      close: async () => {
        await queue;
        await stream.close();
      },
      abort: async () => {
        await queue.catch(() => undefined);
        await stream.abort().catch(() => undefined);
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
    await w.write(blob);
    await w.close();
    return;
  }
  await done((await store("media", "readwrite")).put(blob, `${projectId}:${key}`));
}

/** A media file, typed: OPFS files carry no type of their own. */
export async function getMedia(projectId: string, key: string, type = ""): Promise<Blob | null> {
  const dir = await projectDir(projectId, false);
  if (dir) {
    try {
      const file = await (await dir.getFileHandle(key)).getFile();
      return type && file.type !== type ? new Blob([file], { type }) : file;
    } catch {
      // Not in OPFS: maybe in IndexedDB.
    }
  }
  const blob = (await done((await store("media")).get(`${projectId}:${key}`))) as Blob | undefined;
  return blob ?? null;
}

export async function deleteMedia(projectId: string, key: string): Promise<void> {
  const dir = await projectDir(projectId, false);
  await dir?.removeEntry(key).catch(() => undefined);
  await done((await store("media", "readwrite")).delete(`${projectId}:${key}`));
}

/** Bytes used and available for this site, when the browser says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const e = await navigator.storage?.estimate?.();
  return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
}
