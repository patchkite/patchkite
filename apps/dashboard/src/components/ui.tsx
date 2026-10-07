import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";

export function Button({
  variant = "secondary",
  size,
  icon,
  loading,
  block,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "lg"; icon?: IconName; loading?: boolean; block?: boolean }) {
  const cls = ["btn", `btn-${variant}`, size && `btn-${size}`, block && "btn-block", loading && "is-loading", className].filter(Boolean).join(" ");
  return (
    <button {...props} className={cls} disabled={props.disabled || loading}>
      {icon && <Icon name={icon} size={size === "sm" ? 13 : 14} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input {...props} className={`input${error ? " is-error" : ""}`} />
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="err">
          <Icon name="alert" size={12} />
          {error}
        </span>
      )}
    </label>
  );
}

export function Panel({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel-h">
          {title && <h2>{title}</h2>}
          {actions && <div className="acts">{actions}</div>}
        </div>
      )}
      <div className="panel-b" style={title || actions ? undefined : { paddingTop: 14 }}>
        {children}
      </div>
    </section>
  );
}

export type Tone = "accent" | "green" | "amber" | "red" | "violet" | "gray";
export function Badge({ children, tone, dot }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/** Neutral label with a color swatch (platform/OS). */
export function Lbl({ children, hue }: { children: ReactNode; hue: string }) {
  return (
    <span className="lbl">
      <i style={{ ["--c" as string]: `var(--${hue})` }} />
      {children}
    </span>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <span className="err">
      <Icon name="alert" size={12} />
      {error instanceof Error ? error.message : String(error)}
    </span>
  );
}

export function EmptyState({ icon, title, children, small }: { icon: IconName; title: string; children?: ReactNode; small?: boolean }) {
  return (
    <div className={`empty-state${small ? " sm" : ""}`}>
      <div className="glyph">
        <Icon name={icon} size={22} />
      </div>
      <h3 className="es-h">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- toast

type ToastItem = { id: number; text: string; tone: "ok" | "bad" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <Icon name={t.tone === "ok" ? "circleCheck" : "alert"} size={15} className={t.tone} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- modal

/** Generic modal (forms). Close with Escape, a backdrop click, or the x button. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "lg";
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal-wrap" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className={`modal${size ? ` ${size}` : ""} enter`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-h">
            <h2 id="modal-title">{title}</h2>
            <button type="button" className="ibtn ibtn-sm" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          <div className="modal-b">{children}</div>
          {footer && <div className="modal-f">{footer}</div>}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- confirm modal

type ConfirmOpts = { title: string; body: ReactNode; confirm: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <>
          <div className="scrim" onClick={() => close(false)} />
          <div className="modal-wrap" onKeyDown={(e) => e.key === "Escape" && close(false)}>
            <div className="modal sm enter" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
              <div className="modal-h">
                <h2 id="confirm-title">{state.title}</h2>
                <button className="ibtn ibtn-sm" aria-label="Close" onClick={() => close(false)}>
                  <Icon name="x" />
                </button>
              </div>
              <div className="modal-b muted">{state.body}</div>
              <div className="modal-f">
                <span className="sp" />
                <Button variant="ghost" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button variant={state.danger ? "danger" : "primary"} autoFocus onClick={() => close(true)}>
                  {state.confirm}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </ConfirmCtx.Provider>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="ibtn ibtn-sm"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        toast("Copied to clipboard");
      }}
    >
      <Icon name="copy" size={13} />
    </button>
  );
}

export const formatDate = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
};

export const formatSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- popover

/** Button that opens a floating panel (action menu or explanation). Close with Escape or an outside click. */
export function Popover({
  label,
  icon,
  text,
  variant = "ghost",
  role = "dialog",
  width,
  children,
}: {
  label: string;
  icon?: IconName;
  text?: ReactNode;
  variant?: Variant;
  role?: "menu" | "dialog";
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setRect(null), []);

  useEffect(() => {
    if (!rect) return;
    const el = pop.current;
    (el?.querySelector<HTMLElement>("button:not(:disabled), [href]") ?? el)?.focus({ preventScroll: true });
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!el?.contains(t) && !btn.current?.contains(t)) close();
    };
    // The panel is fixed-positioned: close it if the trigger button moves due to scrolling.
    const onScroll = () => {
      const now = btn.current?.getBoundingClientRect();
      if (!now || Math.abs(now.top - rect.top) > 4 || Math.abs(now.left - rect.left) > 4) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [rect, close]);

  const iconOnly = !text;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={iconOnly ? "ibtn ibtn-sm" : `btn btn-${variant} btn-sm`}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        aria-haspopup={role === "menu" ? "menu" : "dialog"}
        aria-expanded={!!rect}
        onClick={() => setRect(rect ? null : (btn.current?.getBoundingClientRect() ?? null))}
      >
        {icon && <Icon name={icon} size={iconOnly ? 14 : 13} />}
        {text}
      </button>
      {rect && (
        <div
          ref={pop}
          className={`pop enter${role === "dialog" ? " pop-note" : ""}`}
          role={role}
          aria-label={label}
          tabIndex={-1}
          style={{
            top: Math.min(rect.bottom + 6, window.innerHeight - 120),
            right: Math.max(8, window.innerWidth - rect.right),
            width,
            maxWidth: width ? "calc(100vw - 16px)" : undefined,
            transformOrigin: "top right",
          }}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}
