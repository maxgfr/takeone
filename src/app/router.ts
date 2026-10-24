/**
 * Hash routes, so every page works from GitHub Pages without a server:
 *   #/                 home: your recordings
 *   #/record           record a video
 *   #/edit/<id>        edit a project
 *   #/watch/<room>     watch a video streamed from its author's tab
 */
import { signal } from "@preact/signals";

export type Route =
  | { name: "home" }
  | { name: "record"; project: string | null }
  | { name: "edit"; id: string }
  | { name: "watch"; room: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = h.split("?");
  const parts = path.split("/");
  const params = new URLSearchParams(query);
  switch (parts[0]) {
    case "record":
      return { name: "record", project: params.get("project") };
    case "edit":
      return parts[1] ? { name: "edit", id: parts[1] } : { name: "home" };
    case "watch":
      return parts[1] ? { name: "watch", room: parts.slice(1).join("/") } : { name: "home" };
    default:
      return { name: "home" };
  }
}

export const route = signal<Route>(
  parseRoute(typeof location === "undefined" ? "" : location.hash),
);

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    route.value = parseRoute(location.hash);
  });
}

export function navigate(hash: string): void {
  if (location.hash === hash) route.value = parseRoute(hash);
  else location.hash = hash;
}
