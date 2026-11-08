"use client";

import React from "react";
import { errorText, statusClass, STATUS_LABELS } from "@/lib/api";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button {...props} className={`btn btn-${variant} btn-${size} ${props.className ?? ""}`} type={props.type ?? "button"}>
      {children}
    </button>
  );
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusClass(status)}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <header className="card-head">
          <h3>{title}</h3>
          <div className="row">{actions}</div>
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const { message, hint } = errorText(error);
  return (
    <div className="alert alert-bad" role="alert">
      <div>
        <strong>{message}</strong>
        {hint ? <p className="muted small">{hint}</p> : null}
      </div>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          تلاش دوباره
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "ok" | "bad"; children: React.ReactNode }) {
  return <div className={`alert alert-${tone}`}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const dialog = React.useRef<HTMLDivElement | null>(null);

  /*
   * دیالوگ: فوکوس داخل می‌ماند، Escape می‌بندد و فوکوس به عنصر قبلی برمی‌گردد.
   * بدون این، کاربر با صفحه‌کلید می‌توانست پشت دیالوگ گم شود.
   */
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const first = focusables()[0];
    (first ?? node)?.focus();

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      const index = current ? list.indexOf(current) : -1;
      if (event.shiftKey && (index <= 0)) {
        event.preventDefault();
        list[list.length - 1].focus();
      } else if (!event.shiftKey && (index === -1 || index === list.length - 1)) {
        event.preventDefault();
        list[0].focus();
      }
    };
    window.addEventListener("keydown", handler);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = overflow;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialog}
        className={`modal ${wide ? "modal-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="بستن">
            ✕
          </Button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ label = "در حال بارگذاری…" }: { label?: string }) {
  return (
    <div className="spinner-row">
      <span className="spinner" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="muted small">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
