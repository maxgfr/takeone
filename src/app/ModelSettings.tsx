/**
 * Your own model: a provider from the catalog with your key, or an
 * OpenAI-compatible endpoint (Ollama, LM Studio). Calls go straight from the
 * browser to the provider; the key is stored encrypted on this device.
 */
import { useEffect } from "preact/hooks";
import { llm, llmState } from "../ai/settings";
import { Button, Field, Modal, toast } from "./ui";

export function ModelSettings({ onDone }: { onDone: () => void }) {
  const s = llmState.value;
  const d = s.draft;
  useEffect(() => {
    llm.open();
  }, []);
  const all = [...s.providers.recommended, ...s.providers.others];
  return (
    <div class="ai-settings">
      <p class="muted">
        Calls go straight from your browser to the provider with your own key. The key is stored
        encrypted on this device and never leaves it except to that provider.
      </p>
      <fieldset class="segmented" aria-label="Model source">
        <button
          type="button"
          aria-pressed={!d.custom}
          class={!d.custom ? "is-on" : ""}
          onClick={() => llm.toggleCustom(false)}
        >
          Provider
        </button>
        <button
          type="button"
          aria-pressed={d.custom}
          class={d.custom ? "is-on" : ""}
          onClick={() => llm.toggleCustom(true)}
        >
          Custom endpoint
        </button>
      </fieldset>
      {!d.custom ? (
        <>
          {s.catalogStatus === "loading" && <p class="muted">Loading the model catalog…</p>}
          {s.catalogStatus === "error" && (
            <p class="error">
              The model catalog could not be loaded.{" "}
              <button type="button" class="link-btn" onClick={() => llm.retryCatalog()}>
                Retry
              </button>
            </p>
          )}
          <Field label="Provider">
            <select
              class="input"
              value={d.providerId}
              onChange={(e) => llm.selectProvider(e.currentTarget.value)}
            >
              {!d.providerId && <option value="">Choose a provider</option>}
              {s.providers.recommended.length > 0 && (
                <optgroup label="Recommended">
                  {s.providers.recommended.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {s.providers.others.length > 0 && (
                <optgroup label="Others">
                  {s.providers.others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {all.length === 0 && d.providerId && (
                <option value={d.providerId}>{d.providerId}</option>
              )}
            </select>
          </Field>
          <Field
            label="Model"
            hint="Writes titles, chapters and clean-ups. OpenAI, Gemini, Mistral and Groq keys also transcribe."
          >
            <input
              class="input"
              placeholder="Search models"
              value={s.search}
              onInput={(e) => llm.setSearch(e.currentTarget.value)}
            />
            <select
              class="input"
              value={d.model}
              onChange={(e) => llm.selectModel(e.currentTarget.value)}
            >
              {!s.models.some((m) => m.id === d.model) && d.model && (
                <option value={d.model}>{d.model}</option>
              )}
              {s.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {s.recommendedModel?.id === m.id ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Endpoint"
            hint="An OpenAI-compatible URL: https anywhere, or http on this machine (Ollama, LM Studio)."
          >
            <input
              class="input"
              placeholder="http://localhost:11434/v1"
              value={d.customEndpoint}
              onInput={(e) => llm.setEndpoint(e.currentTarget.value)}
            />
          </Field>
          <Field label="Model name">
            <input
              class="input"
              placeholder="llama3.2"
              value={d.customModel}
              onInput={(e) => llm.setCustomModel(e.currentTarget.value)}
            />
          </Field>
        </>
      )}
      <Field label="API key">
        <input
          class="input"
          type="password"
          autoComplete="off"
          spellcheck={false}
          placeholder={d.custom ? "Optional" : "Paste your key"}
          value={s.apiKey}
          onInput={(e) => llm.setApiKey(e.currentTarget.value)}
        />
      </Field>
      <label class="check">
        <input
          type="checkbox"
          checked={d.rememberKey}
          onChange={(e) => llm.setRememberKey(e.currentTarget.checked)}
        />
        Remember the key on this device (otherwise it is forgotten when the tab closes)
      </label>
      {s.testResult && (
        <p class={s.testResult.ok ? "success" : "error"}>
          {s.testResult.ok
            ? "Connection works."
            : s.testResult.reason === "cors"
              ? "Key refused, or the network blocked the request."
              : `Connection failed (${s.testResult.reason}).`}
        </p>
      )}
      <div class="modal-actions">
        <Button disabled={!s.canTest || s.testing} onClick={() => void llm.test()}>
          {s.testing ? "Testing…" : "Test connection"}
        </Button>
        <Button
          variant="primary"
          disabled={!s.canSave}
          onClick={async () => {
            const res = await llm.save();
            if (res.ok) onDone();
            else
              toast(
                res.reason === "incomplete"
                  ? "Choose a model and enter a key."
                  : "This endpoint cannot be used (it must be https, or http on this machine).",
                "error",
              );
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function ModelSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Your AI model" onClose={onClose}>
      <ModelSettings onDone={onClose} />
    </Modal>
  );
}
