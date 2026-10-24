/**
 * One HTML file that plays the video anywhere, offline, from disk or any
 * host: the rendered video inlined as base64 with takeone's player, its
 * chapters, its transcript and its captions.
 */
import type { Project } from "../model/project";
import { outputChapters, outputWords } from "./text";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function playerAssets(): Promise<{ js: string; css: string }> {
  const [js, css] = await Promise.all(
    ["./player/player.js", "./player/player.css"].map(async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error("The player could not be loaded. Are you offline?");
      return res.text();
    }),
  );
  return { js: js as string, css: css as string };
}

export function standaloneHtml(title: string, json: string, js: string, css: string): string {
  // JSON inside a script element must not close it.
  const safe = json.replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="takeone" />
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;min-height:100%;background:#121117}
@media (prefers-color-scheme:light){html,body{background:#f7f6f9}}
.takeone-page{box-sizing:border-box;max-width:1400px;margin:0 auto;padding:clamp(12px,3vw,32px)}
${css}
</style>
</head>
<body>
<main class="takeone-page"><div id="takeone"></div></main>
<script type="application/json" id="takeone-data">${safe}</script>
<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}

/** The HTML file for a rendered video of the project. */
export async function exportHtml(project: Project, video: Blob): Promise<Blob> {
  const [assets, b64] = await Promise.all([playerAssets(), toBase64(video)]);
  const payload = {
    title: project.title,
    duration: outputWords(project).at(-1)?.end ?? 0,
    words: outputWords(project).map((w) => ({
      text: w.text,
      start: Math.round(w.start * 1000) / 1000,
      end: Math.round(w.end * 1000) / 1000,
    })),
    chapters: outputChapters(project),
    type: video.type,
    video: b64,
  };
  return new Blob([standaloneHtml(project.title, JSON.stringify(payload), assets.js, assets.css)], {
    type: "text/html",
  });
}
