/**
 * Production build: Bun.build on index.html with hashed chunks and relative
 * paths (the site lives under /takeone/), each worker built on its own with its
 * URL injected into the app, and a CSP injected into the page.
 *
 * The CSP lets the page call any https API (the user's AI provider, Hugging
 * Face for on-device models) and wss: (the relays and trackers that introduce
 * peers to each other), and nothing else: no inline script, no eval, no
 * third-party script. WebAssembly may be compiled (noise removal, speech to text).
 * The build fails if index.html has an inline script or a reference to
 * another origin.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { projectSchema } from "../src/model/project";

const ROOT = resolve(import.meta.dir, "..");

/** The project format as JSON Schema, for people and agents. */
function projectJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(projectSchema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* data: blob:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const DESCRIPTION =
  "Record your screen, camera and voice, edit the video by editing its text, and share it without a server. Everything runs in your browser.";

function headInject(): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    `<meta name="referrer" content="no-referrer" />`,
    `<meta name="color-scheme" content="dark light" />`,
    `<meta name="theme-color" content="#14121a" />`,
    `<meta name="description" content="${DESCRIPTION}" />`,
    `<meta property="og:title" content="takeone" />`,
    `<meta property="og:description" content="${DESCRIPTION}" />`,
    `<link rel="icon" href="./icon.svg" type="image/svg+xml" />`,
  ].join("\n    ");
}

/** Workers built on their own; `define` is the global the app reads their URL from. */
export const WORKERS: { entry: string; define: string }[] = [
  { entry: "src/workers/clock.ts", define: "__CLOCK_WORKER_URL__" },
  { entry: "src/workers/speech.ts", define: "__SPEECH_WORKER_URL__" },
];

export interface BuildOptions {
  outdir?: string;
  minify?: boolean;
}

function fail(msg: string): never {
  throw new Error(`build: ${msg}`);
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

function assertOk(result: Awaited<ReturnType<typeof Bun.build>>, what: string): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    fail(`${what} failed`);
  }
}

/** Throws if the HTML has an inline script, inline handler, inline style or external URL. */
export function auditHtml(html: string, page = "index.html"): void {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    if (!/\bsrc\s*=/.test(attrs) || body.length > 0) fail(`inline <script> found in ${page}`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) fail(`inline event handler found in ${page}`);
  if (/<style\b/i.test(html)) fail(`inline <style> found in ${page}`);
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const url = m[1] ?? "";
    if (/^(?:[a-z]+:)?\/\//i.test(url)) fail(`external URL in ${page}: ${url}`);
    if (url.startsWith("/")) fail(`absolute path in ${page} (breaks the /takeone/ base): ${url}`);
  }
}

export async function build(opts: BuildOptions = {}): Promise<{ outdir: string; files: string[] }> {
  const outdir = resolve(ROOT, opts.outdir ?? "dist");
  const minify = opts.minify ?? true;
  const env = { "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development") };
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  // 1. Workers, each with its URL injected into the app.
  const defines: Record<string, string> = { ...env };
  for (const w of WORKERS) {
    const res = await Bun.build({
      entrypoints: [join(ROOT, w.entry)],
      outdir,
      minify,
      target: "browser",
      format: "esm",
      naming: { entry: "assets/[name]-[hash].[ext]", chunk: "assets/[name]-[hash].[ext]" },
      define: env,
    });
    assertOk(res, `${w.entry} build`);
    const out = res.outputs.find((o) => o.kind === "entry-point") ?? fail(`no ${w.entry} output`);
    defines[w.define] = JSON.stringify(`./${relative(outdir, out.path).split("\\").join("/")}`);
  }

  // The one onnxruntime build both llm-connect/nemo and transformers.js load (WebGPU and
  // WebAssembly), for speech to text on the device: served from this site, never from a CDN.
  const transformers = dirname(Bun.resolveSync("@huggingface/transformers/package.json", ROOT));
  const ort = join(dirname(Bun.resolveSync("onnxruntime-web/package.json", transformers)), "dist");
  await mkdir(join(outdir, "ort"), { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
    await cp(join(ort, f), join(outdir, "ort", f));

  // 2. The app.
  const app = await Bun.build({
    entrypoints: [join(ROOT, "index.html")],
    outdir,
    minify,
    splitting: true,
    target: "browser",
    format: "esm",
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: defines,
  });
  assertOk(app, "app build");

  // 3. The standalone player: one file, inlined into exported HTML.
  const player = await Bun.build({
    entrypoints: [join(ROOT, "src/player/standalone.tsx")],
    outdir: join(outdir, "player"),
    minify,
    target: "browser",
    format: "esm",
    naming: { entry: "player.js" },
    define: env,
  });
  assertOk(player, "player build");
  await cp(join(ROOT, "src/player/player.css"), join(outdir, "player/player.css"));

  // 4. Static files, and the schema of the project format.
  await cp(join(ROOT, "public"), outdir, { recursive: true });
  await writeFile(join(outdir, "schema.json"), `${JSON.stringify(projectJsonSchema(), null, 2)}\n`);

  // 5. Harden the page.
  const path = join(outdir, "index.html");
  let html = await readFile(path, "utf8");
  if (!/<meta charset="utf-8"\s*\/?>/i.test(html))
    fail("index.html must start with <meta charset>");
  html = html.replace(/(<meta charset="utf-8"\s*\/?>)/i, `$1\n    ${headInject()}`);
  auditHtml(html);
  await writeFile(path, html);

  return { outdir, files: await listFiles(outdir) };
}

if (import.meta.main) {
  const started = performance.now();
  const res = await build({ minify: !process.argv.includes("--dev") });
  let bytes = 0;
  for (const f of res.files) bytes += (await stat(join(res.outdir, f))).size;
  console.log(
    `built ${res.files.length} files (${(bytes / 1024).toFixed(1)} KiB) in ${Math.round(performance.now() - started)} ms`,
  );
}
