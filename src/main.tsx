import { render } from "preact";
import { Home } from "./app/Home";
import { ProjectPage } from "./app/ProjectPage";
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

/** The page for the current route (more pages arrive with each milestone). */
function Page() {
  const r = route.value;
  switch (r.name) {
    case "record":
      return <Record projectId={r.project} />;
    case "edit":
      return <ProjectPage id={r.id} />;
    default:
      return <Home />;
  }
}

function App() {
  return (
    <div class="shell">
      <header class="topbar">
        <Brand />
        <nav class="topnav">
          <a href="#/record">Record</a>
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
