/** Small shared UI pieces: icons, buttons, dialogs, toasts. */
import { signal } from "@preact/signals";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

const PATHS = {
  record:
    "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0",
  video: "M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 1 0 0-.01",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  sparkles:
    "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  play: "M7 5v14l12-7z",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  plus: "M12 5v14M5 12h14",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  back: "M15 18l-6-6 6-6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  download: "M12 3v12M7 10l5 5 5-5M4 19h16",
  close: "M6 6l12 12M18 6L6 18",
  cursor: "M5 3l14 7-6 2-2 6z",
  hotspot: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0",
  highlight: "M3 3h18v18H3zM8 8h8v8H8z",
  blur: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4zM10 10h4v4h-4z",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  zoom: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-5-5M11 8v6M8 11h6",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  github:
    "M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.9-2.4c3-.3 6-1.5 6-6.6a5 5 0 0 0-1.4-3.6 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.5 0C6 1.1 4.9 1.4 4.9 1.4a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.4 8.5c0 5.1 3 6.3 6 6.6a3 3 0 0 0-.9 2.3V21",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  check: "M5 12l5 5L20 7",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  clipboard: "M9 4h6v3H9zM8 5H6v16h12V5h-2",
  wand: "M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  class: cls,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  const filled = name === "play" || name === "stop";
  return (
    <svg
      class={`icon ${cls ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  disabled?: boolean;
  type?: "button" | "submit";
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  class: cls,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button type={type ?? "button"} class={`btn btn-${variant} btn-${size} ${cls ?? ""}`} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 18} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  ...rest
}: { icon: IconName; label: string } & JSX.HTMLAttributes<HTMLButtonElement> & {
    disabled?: boolean;
  }) {
  return (
    <button type="button" class="icon-btn" aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Escape goes through the cancel event
    <dialog
      ref={ref}
      class={`modal ${wide ? "modal-wide" : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="modal-inner">
        <header class="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div class="modal-body">{children}</div>
      </div>
    </dialog>
  );
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast["kind"] = "info", ms = 4200): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, ms);
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "Cancelled.";
  if (err instanceof DOMException && err.name === "NotAllowedError")
    return "Permission was refused.";
  if (
    err instanceof DOMException &&
    (err.name === "NotFoundError" || err.name === "NotSupportedError")
  )
    return "No such device was found.";
  if (err instanceof DOMException && err.name === "NotReadableError")
    return "The device is busy: another app may be using it.";
  return err instanceof Error ? err.message : String(err);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}
