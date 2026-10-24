import { type ComponentType, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Editor } from "./app/editor/Editor";
import { Home } from "./app/Home";
import { Record } from "./app/Record";
import { route } from "./app/router";
import { Icon, Toasts } from "./app/ui";

function Brand() {
  return (
    <a class="brand" href="#/" aria-label="takeone home">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--accent)" />
        <circle cx="16" cy="16" r="8" fill="none" stroke="#fff" stroke-width="2.4" />
        <circle cx="16" cy="16" r="3.6" fill="#fff" />
      </svg>
      <span>takeone</span>
    </a>
  );
}

/** The watch page and its peer-to-peer stack load on demand: the home page does not need them. */
function WatchPage({ room }: { room: string }) {
  const [Watch, setWatch] = useState<ComponentType<{ room: string }> | null>(null);
  useEffect(() => {
    void import("./app/Watch").then((m) => setWatch(() => m.Watch));
  }, []);
  return Watch ? (
    <Watch key={room} room={room} />
  ) : (
    <main class="watch">
      <div class="spinner" role="status" aria-label="Loading" />
    </main>
  );
}

/** The page for the current route (more pages arrive with each milestone). */
function Page() {
  const r = route.value;
  switch (r.name) {
    case "record":
      return <Record projectId={r.project} />;
    case "watch":
      return <WatchPage room={r.room} />;
    default:
      return <Home />;
  }
}

function App() {
  // The editor takes the whole window.
  if (route.value.name === "edit")
    return (
      <>
        <Editor id={route.value.id} />
        <Toasts />
      </>
    );
  return (
    <div class="shell">
      <header class="topbar">
        <Brand />
        <nav class="topnav">
          <a href="#/record">Record</a>
          <a href="./llms.txt" target="_blank" rel="noopener">
            For AI agents
          </a>
          <a
            class="icon-link"
            href="https://github.com/maxgfr/takeone"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Source on GitHub"
          >
            <Icon name="github" />
          </a>
        </nav>
      </header>
      <Page />
      <footer class="footer">
        <span>
          takeone runs entirely in your browser. Recordings and keys stay on this device; AI calls
          go straight to the provider you choose.
        </span>
        <a href="https://github.com/maxgfr/takeone" target="_blank" rel="noopener noreferrer">
          MIT · GitHub
        </a>
      </footer>
      <Toasts />
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
