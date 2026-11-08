"use client";

import { useMemo, useRef, useState } from "react";
import { api, errorText, formatDate } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, Notice, Spinner } from "@/components/ui";
import type { ReferenceAsset } from "@/lib/types";

const ROLES: Array<{ id: string; label: string }> = [
  { id: "identity", label: "هویت" },
  { id: "face", label: "چهره" },
  { id: "body", label: "بدن" },
  { id: "clothing", label: "لباس" },
  { id: "tool", label: "ابزار" },
  { id: "pose", label: "ژست" },
  { id: "location", label: "مکان" },
  { id: "style", label: "سبک" },
  { id: "composition", label: "ترکیب‌بندی" },
  { id: "scale", label: "مقیاس" },
  { id: "map", label: "نقشه" },
  { id: "expression", label: "حالت چهره" },
];

const STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  approved: "تأییدشده",
  rejected: "ردشده",
  archived: "بایگانی",
};

interface Pending {
  id: string;
  filename: string;
  title: string;
  dataUrl: string;
  thumb: string | null;
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود."));
    reader.readAsDataURL(file);
  });
}

/** بندانگشتی در مرورگر ساخته می‌شود تا فایل بزرگ برای نمایش بارگذاری نشود. */
async function makeThumb(dataUrl: string, max = 420): Promise<string | null> {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("تصویر خوانده نشد."));
      img.src = dataUrl;
    });
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.82);
  } catch {
    return null;
  }
}

export default function RefsView() {
  const ctx = useWorkspace();
  const { bundle, reload } = ctx;
  const [references, setReferences] = useState<ReferenceAsset[]>(bundle.references);
  const [pending, setPending] = useState<Pending[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>(["identity"]);
  const [licenseNote, setLicenseNote] = useState("");
  const [filter, setFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReferenceAsset | null>(null);
  const [newVersionTarget, setNewVersionTarget] = useState<ReferenceAsset | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);

  const charactersAndPlaces = bundle.entities.filter((e) => ["character", "location", "object", "group"].includes(e.kind));

  const refresh = async () => {
    const data = await api<{ references: ReferenceAsset[] }>(`/api/projects/${bundle.project.id}/references`);
    setReferences(data.references);
    await reload();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const next: Pending[] = [];
      for (const file of Array.from(files).slice(0, 12)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await readFileAsDataUrl(file);
        const thumb = await makeThumb(dataUrl);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: file.name,
          title: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 120),
          dataUrl,
          thumb,
        });
      }
      setPending((current) => [...current, ...next]);
      if (next.length === 0) setError(new Error("فایل تصویری معتبری انتخاب نشد."));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const uploadPending = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const item of pending) {
        await api(`/api/projects/${bundle.project.id}/references`, {
          method: "POST",
          json: {
            dataUrl: item.dataUrl,
            thumbDataUrl: item.thumb ?? undefined,
            filename: item.filename,
            title: item.title || item.filename,
            entityIds: entities,
            roles,
            licenseNote,
            origin: "local_upload",
            status: "draft",
          },
        });
      }
      setPending([]);
      setNotice("مرجع‌ها به‌صورت پیش‌نویس افزوده شدند. برای استفاده در تولید باید تأیید شوند.");
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const updateRef = async (ref: ReferenceAsset, patch: Partial<ReferenceAsset>) => {
    setBusy(true);
    try {
      const data = await api<{ reference: ReferenceAsset }>(`/api/references/${ref.id}`, { method: "PATCH", json: patch });
      setReferences((list) => list.map((r) => (r.id === ref.id ? data.reference : r)));
      setDetail((d) => (d && d.id === ref.id ? data.reference : d));
      setNotice(patch.status === "approved" ? "مرجع تأیید شد. پنل‌های وابسته «نیازمند بازبینی» علامت خوردند." : null);
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async (file: File | null | undefined) => {
    if (!file || !newVersionTarget) return;
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const thumb = await makeThumb(dataUrl);
      const upload = await api<{ asset: { id: string } }>(`/api/projects/${bundle.project.id}/references`, {
        method: "POST",
        json: {
          dataUrl,
          thumbDataUrl: thumb ?? undefined,
          filename: file.name,
          title: `${newVersionTarget.title} — نسخهٔ تازه`,
          entityIds: newVersionTarget.entityIds,
          roles: newVersionTarget.roles,
          origin: "ai_output",
          status: "draft",
        },
      });
      // رکورد موقت ساخته‌شده حذف نمی‌شود؛ به‌جای آن نسخهٔ تازه به آن گره می‌خورد تا فایل تلف نشود.
      await api(`/api/references/${newVersionTarget.id}`, { method: "POST", json: { action: "new-version", assetId: upload.asset.id } });
      setNewVersionTarget(null);
      setNotice("نسخهٔ تازهٔ مرجع ساخته شد؛ نسخهٔ تأییدشدهٔ قبلی دست‌نخورده ماند.");
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (versionInput.current) versionInput.current.value = "";
    }
  };

  const filtered = useMemo(() => {
    const needle = filter.trim();
    return references.filter((ref) => {
      if (roleFilter !== "all" && !ref.roles.includes(roleFilter)) return false;
      if (statusFilter !== "all" && ref.status !== statusFilter) return false;
      if (!needle) return true;
      return `${ref.title} ${ref.description} ${ref.tags.join(" ")}`.includes(needle);
    });
  }, [references, filter, roleFilter, statusFilter]);

  return (
    <div className="col" style={{ gap: 14 }}>
      <ErrorNote error={error} />
      {notice ? (
        <Notice tone="ok">
          <div className="row between">
            <span>{notice}</span>
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
              بستن
            </Button>
          </div>
        </Notice>
      ) : null}

      <div
        className="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          event.currentTarget.dataset.drag = "true";
        }}
        onDragLeave={(event) => {
          delete event.currentTarget.dataset.drag;
        }}
        onDrop={(event) => {
          event.preventDefault();
          delete event.currentTarget.dataset.drag;
          void addFiles(event.dataTransfer.files);
        }}
      >
      <Card
        title="افزودن تصویر مرجع"
        actions={
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            انتخاب فایل تصویری
          </Button>
        }
      >
        <p className="small muted">
          تصویر را اینجا رها کنید یا فایل انتخاب کنید. اصل فایل حفظ می‌شود و هش، اندازه، نوع، منشأ و یادداشت مجوز ثبت
          می‌شود. فایل فقط از مسیری که خودتان انتخاب می‌کنید خوانده می‌شود؛ برنامه کل پوشه‌ها را نمی‌خواند.
        </p>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: "none" }} onChange={(e) => void addFiles(e.target.files)} />
        <div className="grid grid-2">
          <div>
            <span className="field-label">موجودیت‌های مرتبط</span>
            <div className="chip-list">
              {charactersAndPlaces.map((entity) => {
                const on = entities.includes(entity.id);
                return (
                  <button
                    key={entity.id}
                    className={`chip ${on ? "on" : ""}`}
                    onClick={() => setEntities(on ? entities.filter((id) => id !== entity.id) : [...entities, entity.id])}
                  >
                    {entity.name}
                  </button>
                );
              })}
              {charactersAndPlaces.length === 0 ? <span className="small muted">نخست در «جهان داستان» موجودیت بسازید.</span> : null}
            </div>
            <div style={{ height: 10 }} />
            <span className="field-label">نقش مرجع (چند نقش مجاز است)</span>
            <div className="chip-list">
              {ROLES.map((role) => {
                const on = roles.includes(role.id);
                return (
                  <button
                    key={role.id}
                    className={`chip ${on ? "on" : ""}`}
                    onClick={() => setRoles(on ? roles.filter((r) => r !== role.id) : [...roles, role.id])}
                  >
                    {role.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <Field label="یادداشت مجوز / منشأ" hint="برای تصاویر دانلودشده یا تولیدشده با AI ثبت کنید.">
              <input value={licenseNote} onChange={(e) => setLicenseNote(e.target.value)} placeholder="مثلاً: ساختهٔ خودم؛ استفادهٔ شخصی" />
            </Field>
            {pending.length ? (
              <>
                <div className="panel-grid">
                  {pending.map((item) => (
                    <div key={item.id} className="panel-card">
                      {item.thumb ? <img src={item.thumb} alt={item.title} /> : <div style={{ height: 120 }} />}
                      <div className="body">
                        <input
                          value={item.title}
                          onChange={(e) => setPending((list) => list.map((p) => (p.id === item.id ? { ...p, title: e.target.value } : p)))}
                          aria-label="عنوان مرجع"
                        />
                        <Button size="sm" variant="ghost" onClick={() => setPending((list) => list.filter((p) => p.id !== item.id))}>
                          حذف از صف
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button variant="primary" onClick={() => void uploadPending()} disabled={busy}>
                  افزودن {pending.length} مرجع به کتابخانه
                </Button>
              </>
            ) : (
              <Empty title="فایلی در صف نیست." hint="PNG، JPEG یا WebP تا ۴۰ مگابایت." />
            )}
          </div>
        </div>
      </Card>
      </div>

      <Card
        title="کتابخانهٔ مراجع"
        actions={
          <div className="row">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="جست‌وجو" style={{ width: 160 }} />
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ width: 130 }}>
              <option value="all">همهٔ نقش‌ها</option>
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 120 }}>
              <option value="all">همه</option>
              <option value="draft">پیش‌نویس</option>
              <option value="approved">تأییدشده</option>
              <option value="rejected">ردشده</option>
            </select>
          </div>
        }
      >
        {busy ? <Spinner /> : null}
        {filtered.length === 0 ? <Empty title="مرجعی مطابق فیلتر نیست." /> : null}
        <div className="gallery">
          {filtered.map((ref) => (
            <figure key={ref.id} className={`gallery-item ${ref.status === "approved" ? "ok" : ""}`}>
              <button className="gallery-image" onClick={() => setDetail(ref)} aria-label={`باز کردن ${ref.title}`}>
                <img src={ref.thumbUrl} alt={ref.title} loading="lazy" />
                <span className="gallery-badges">
                  <Badge tone={ref.status === "approved" ? "ok" : ref.status === "rejected" ? "bad" : "warn"}>{STATUS_LABELS[ref.status]}</Badge>
                  {ref.origin === "ai_output" ? <Badge tone="muted">AI</Badge> : null}
                </span>
              </button>
              <figcaption>
                <strong>{ref.title}</strong>
                <span className="small muted">
                  {ref.entityIds.map((id) => bundle.entities.find((e) => e.id === id)?.name ?? id).join("، ") || "بدون موجودیت"}
                </span>
                <span className="small muted">{ref.roles.map((r) => ROLES.find((x) => x.id === r)?.label ?? r).join(" · ")}</span>
                {ref.validFrom || ref.validTo ? (
                  <span className="tiny muted">
                    معتبر: {ref.validFrom ?? "…"} تا {ref.validTo ?? "…"}
                  </span>
                ) : null}
                <span className="tiny muted">نسخهٔ {ref.version}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </Card>

      {detail ? (
        <Modal title={detail.title} onClose={() => setDetail(null)} wide>
          <div className="grid grid-2">
            <div>
              <img src={detail.thumbUrl} alt={detail.title} style={{ width: "100%", borderRadius: 10, border: "1px solid var(--border)" }} />
              <p className="small muted" style={{ marginTop: 6 }}>
                نسخهٔ {detail.version} · {formatDate(detail.createdAt)} · {detail.origin === "ai_output" ? "خروجی AI" : detail.origin === "imported" ? "واردشده" : "بارگذاری محلی"}
              </p>
            </div>
            <div>
              <Field label="عنوان">
                <input defaultValue={detail.title} onBlur={(e) => void updateRef(detail, { title: e.target.value })} />
              </Field>
              <Field label="توضیح">
                <textarea rows={3} defaultValue={detail.description} onBlur={(e) => void updateRef(detail, { description: e.target.value })} />
              </Field>
              <Field label="یادداشت مجوز">
                <input defaultValue={detail.licenseNote} onBlur={(e) => void updateRef(detail, { licenseNote: e.target.value })} />
              </Field>
              <span className="field-label">موجودیت‌های مرتبط</span>
              <div className="chip-list" style={{ marginBottom: 8 }}>
                {charactersAndPlaces.map((entity) => {
                  const on = detail.entityIds.includes(entity.id);
                  return (
                    <button
                      key={entity.id}
                      className={`chip ${on ? "on" : ""}`}
                      onClick={() =>
                        void updateRef(detail, { entityIds: on ? detail.entityIds.filter((id) => id !== entity.id) : [...detail.entityIds, entity.id] })
                      }
                    >
                      {entity.name}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-2">
                <Field label="معتبر از تاریخ داستان">
                  <input type="date" defaultValue={detail.validFrom ?? ""} onBlur={(e) => void updateRef(detail, { validFrom: e.target.value || null })} />
                </Field>
                <Field label="معتبر تا تاریخ داستان" hint="برای زخم، لباس یا سن، بازه را مشخص کنید.">
                  <input type="date" defaultValue={detail.validTo ?? ""} onBlur={(e) => void updateRef(detail, { validTo: e.target.value || null })} />
                </Field>
              </div>
              <span className="field-label">نقش‌ها</span>
              <div className="chip-list" style={{ marginBottom: 8 }}>
                {ROLES.map((role) => {
                  const on = detail.roles.includes(role.id);
                  return (
                    <button
                      key={role.id}
                      className={`chip ${on ? "on" : ""}`}
                      onClick={() => void updateRef(detail, { roles: on ? detail.roles.filter((r) => r !== role.id) : [...detail.roles, role.id] })}
                    >
                      {role.label}
                    </button>
                  );
                })}
              </div>
              <div className="row">
                {detail.status !== "approved" ? (
                  <Button variant="primary" size="sm" onClick={() => void updateRef(detail, { status: "approved" })} disabled={busy}>
                    تأیید مرجع
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void updateRef(detail, { status: "draft" })} disabled={busy}>
                    لغو تأیید
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void updateRef(detail, { status: "rejected" })}>
                  رد
                </Button>
                <Button size="sm" onClick={() => { setNewVersionTarget(detail); versionInput.current?.click(); }}>
                  نسخهٔ تازه از فایل
                </Button>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                خروجی تازه به‌صورت پیش‌نویس اضافه می‌شود و نسخهٔ تأییدشده را بی‌صدا جایگزین نمی‌کند.
              </p>
            </div>
          </div>
          <input
            ref={versionInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => void createVersion(e.target.files?.[0])}
          />
        </Modal>
      ) : null}
    </div>
  );
}
