/**
 * Bring-your-own-model settings, from llm-connect: the catalog built live from
 * llm-models (models.json as the offline fallback), the key encrypted at rest
 * under a non-extractable WebCrypto key, a free connection test. The same
 * settings transcribe (the provider's speech-to-text model) and write
 * (titles, chapters, clean-ups).
 */
import { signal } from "@preact/signals";
import {
  type Capabilities,
  createLlmSettingsStore,
  isConfigured,
  type LlmSettings,
  type LlmSettingsState,
  liveCatalog,
  modelIdOf,
  providerKindOf,
  resolveCapabilities,
  type SlimModel,
  secureStorage,
} from "llm-connect";

export const llm = createLlmSettingsStore({
  catalog: liveCatalog({
    fallbackUrl: "./models.json",
    required: ["openai", "anthropic", "google"],
  }),
  storage: secureStorage({ prefsKey: "takeone-ai", dbName: "takeone-secrets" }),
  defaults: { language: "en" },
});

export const llmState = signal<LlmSettingsState>(llm.getState());
llm.subscribe((s) => {
  llmState.value = s;
});

let loaded: Promise<unknown> | null = null;
export function loadLlmSettings(): Promise<unknown> {
  loaded ??= llm.load().catch(() => null);
  return loaded;
}

/** The saved settings, when they can call a model. */
export function savedSettings(): LlmSettings | null {
  const saved = llm.getState().saved;
  return saved && isConfigured(saved) ? (saved as LlmSettings) : null;
}

function catalogModel(settings: LlmSettings): SlimModel | undefined {
  const catalog = llm.getState().catalog;
  if (!catalog || !settings.providerId) return undefined;
  return catalog[settings.providerId]?.models[settings.model];
}

/** What the model takes (images, effort…), from the catalog's entry when there is one. */
export function capabilitiesOf(settings: LlmSettings): Capabilities {
  const catalog = catalogModel(settings);
  return resolveCapabilities({
    kind: providerKindOf(settings),
    modelId: modelIdOf(settings),
    ...(catalog ? { catalog } : {}),
  });
}

export function modelLabel(settings: LlmSettings | null): string {
  if (!settings) return "No model";
  if (settings.customEndpoint) return settings.customModel || "Custom endpoint";
  return `${settings.providerName ?? settings.providerId ?? ""} · ${catalogModel(settings)?.name ?? settings.model}`;
}
