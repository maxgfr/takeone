/**
 * Captions, in the settings: on or off, their size and place, the word being
 * said highlighted, and the language shown: the original or a translation
 * made by the user's model, which can be deleted or made again.
 */
import { signal, useSignal } from "@preact/signals";
import { languageName, RESPONSE_LANGUAGES } from "llm-connect";
import { llmState, loadLlmSettings, savedSettings } from "../../ai/settings";
import { translateCaptions } from "../../ai/translate";
import type { Style } from "../../model/project";
import { ModelSettingsModal } from "../ModelSettings";
import { Button, errorText, toast } from "../ui";
import { project, update } from "./state";

type Captions = Style["captions"];

const translating = signal<{
  language: string;
  done: number;
  total: number;
  ctrl: AbortController;
} | null>(null);

function setCaptions(patch: (c: Captions) => Captions, tag: string) {
  update((p) => ({ ...p, style: { ...p.style, captions: patch(p.style.captions) } }), tag);
}

function labelOf(code: string): string {
  return RESPONSE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

async function translate(language: string) {
  await loadLlmSettings();
  const settings = savedSettings();
  const p = project.value;
  if (!settings || !p || translating.value) return;
  const ctrl = new AbortController();
  translating.value = { language, done: 0, total: 1, ctrl };
  try {
    const pieces = await translateCaptions(
      settings,
      p,
      language,
      (done, total) => {
        if (translating.value) translating.value = { ...translating.value, done, total };
      },
      ctrl.signal,
    );
    update((x) => ({
      ...x,
      translations: { ...x.translations, [language]: pieces },
      style: { ...x.style, captions: { ...x.style.captions, language, enabled: true } },
    }));
    toast(`Captions translated into ${labelOf(language)}.`, "success");
  } catch (err) {
    if (!ctrl.signal.aborted) toast(errorText(err), "error", 8000);
  } finally {
    translating.value = null;
  }
}

export function CaptionsSection() {
  const settingsOpen = useSignal(false);
  const p = project.value;
  if (!p) return null;
  void llmState.value;
  const c = p.style.captions;
  const transcribed = p.clips.some((x) => x.transcript?.words.length);
  const spoken = p.clips.find((x) => x.transcript?.language)?.transcript?.language;
  const languages = Object.keys(p.translations);
  const shown = c.language && p.translations[c.language] ? c.language : "";
  const job = translating.value;
  const settings = savedSettings();

  return (
    <section class="insp-section" aria-label="Captions">
      <h3>Captions</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={c.enabled}
          onChange={(e) =>
            setCaptions((x) => ({ ...x, enabled: e.currentTarget.checked }), "cap-on")
          }
        />
        Show captions
      </label>
      {!transcribed && (
        <p class="muted small">Captions come from the transcript: transcribe a take first.</p>
      )}
      <label class="slider">
        Size
        <input
          type="range"
          class="range"
          min={0.025}
          max={0.08}
          step={0.0025}
          value={c.size}
          onInput={(e) =>
            setCaptions((x) => ({ ...x, size: Number(e.currentTarget.value) }), "cap-size")
          }
        />
      </label>
      <fieldset class="segmented" aria-label="Captions position">
        {(["bottom", "top"] as const).map((pos) => (
          <button
            key={pos}
            type="button"
            aria-pressed={c.position === pos}
            class={c.position === pos ? "is-on" : ""}
            onClick={() => setCaptions((x) => ({ ...x, position: pos }), "cap-pos")}
          >
            {pos === "bottom" ? "Bottom" : "Top"}
          </button>
        ))}
      </fieldset>
      <label class="check">
        <input
          type="checkbox"
          checked={c.karaoke}
          onChange={(e) =>
            setCaptions((x) => ({ ...x, karaoke: e.currentTarget.checked }), "cap-k")
          }
        />
        Highlight each word as it is said
      </label>
      <label class="field">
        <span class="field-label">Language shown</span>
        <select
          class="input"
          value={shown}
          onChange={(e) =>
            setCaptions((x) => ({ ...x, language: e.currentTarget.value || null }), "cap-lang")
          }
        >
          <option value="">Original{spoken ? ` (${languageName(spoken)})` : ""}</option>
          {languages.map((code) => (
            <option key={code} value={code}>
              {labelOf(code)}
            </option>
          ))}
        </select>
      </label>
      {shown && (
        <button
          type="button"
          class="link-btn small caption-delete"
          onClick={() =>
            update((x) => {
              const { [shown]: _, ...rest } = x.translations;
              return {
                ...x,
                translations: rest,
                style: { ...x.style, captions: { ...x.style.captions, language: null } },
              };
            })
          }
        >
          Delete the {labelOf(shown)} translation
        </button>
      )}
      {job ? (
        <div class="ai-busy" role="status">
          <span class="spinner spinner-sm" aria-hidden="true" />
          <span>
            Translating into {labelOf(job.language)}
            {job.total > 1 ? ` · ${job.done}/${job.total}` : "…"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => job.ctrl.abort()}>
            Cancel
          </Button>
        </div>
      ) : settings ? (
        <select
          class="input"
          aria-label="Translate into"
          value=""
          disabled={!transcribed}
          onChange={(e) => {
            const code = e.currentTarget.value;
            e.currentTarget.value = "";
            if (code) void translate(code);
          }}
        >
          <option value="">Translate into…</option>
          {RESPONSE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
              {languages.includes(l.code) ? " · again" : ""}
            </option>
          ))}
        </select>
      ) : (
        <p class="muted small">
          Translations use your own AI model.{" "}
          <button type="button" class="link-btn small" onClick={() => (settingsOpen.value = true)}>
            Set one up
          </button>
        </p>
      )}
      {settingsOpen.value && <ModelSettingsModal onClose={() => (settingsOpen.value = false)} />}
    </section>
  );
}
