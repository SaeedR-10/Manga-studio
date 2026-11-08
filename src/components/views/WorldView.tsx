"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText, formatDate, STATUS_LABELS } from "@/lib/api";
import { useWorkspace } from "@/components/workspace";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, Notice, Spinner, StatusBadge } from "@/components/ui";
import type { Entity, EntityVersion, Fact } from "@/lib/types";

type EntityWithVersions = Entity & { versions: EntityVersion[] };

const KIND_LABELS: Record<string, string> = {
  character: "شخصیت",
  location: "مکان",
  object: "شیء",
  group: "گروه",
  rule: "قانون جهان",
};

const LAYER_LABELS: Record<string, string> = {
  identity: "هویت (ثابت)",
  face: "چهره",
  body: "بدن",
  birthmark: "نشانهٔ مادرزادی",
  clothing: "لباس",
  equipment: "تجهیزات",
  injury: "آسیب موقت",
  age: "سن",
  expression: "حالت چهره",
};

const STATUS_OPTIONS = ["proposed", "confirmed", "rejected", "retired"] as const;

export default function WorldView() {
  const ctx = useWorkspace();
  const { bundle, reload } = ctx;
  const [entities, setEntities] = useState<EntityWithVersions[]>([]);
  const [facts, setFacts] = useState<Fact[]>(bundle.facts);
  const [timeline, setTimeline] = useState<Array<{ id: string; label: string; storyDate: string | null; kind: string; note: string }>>([]);
  const [conflicts, setConflicts] = useState<Array<{ key: string; facts: Array<{ id: string; value: string; scopeStart: string | null; scopeEnd: string | null }> }>>([]);
  const [canon, setCanon] = useState<{ entries: Array<{ subject: string; attribute: string; value: string | null; status: string; reason: string }>; conflicts: string[] } | null>(null);
  const [warnings, setWarnings] = useState<{ conflicts: Array<Array<{ id: string; attribute: string; value: string }>>; unknown: Array<{ subjectId: string; attribute: string; reason: string }> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<EntityWithVersions | null>(null);
  const [deps, setDeps] = useState<{ scenes: Array<{ id: string; title: string; storyDate: string | null }>; panels: Array<{ id: string; title: string; sceneId: string }> } | null>(null);
  const [profile, setProfile] = useState({ name: "", summary: "" });

  const [entityKind, setEntityKind] = useState("character");
  const [entityName, setEntityName] = useState("");
  const [entitySummary, setEntitySummary] = useState("");
  const [factForm, setFactForm] = useState({ subjectId: "", attribute: "", value: "", sourceType: "user_decision", scopeStart: "", scopeEnd: "", status: "confirmed" as (typeof STATUS_OPTIONS)[number] });
  const [versionForm, setVersionForm] = useState({ layer: "clothing", label: "", validFrom: "", validTo: "", notes: "", value: "" });
  const [timelineForm, setTimelineForm] = useState({ label: "", storyDate: "", kind: "event" });

  const loadWorld = useCallback(async () => {
    setLoading(true);
    try {
      const sceneId = ctx.selectedSceneId ? `?sceneId=${ctx.selectedSceneId}` : "";
      const data = await api<{
        entities: EntityWithVersions[];
        facts: Fact[];
        timeline: typeof timeline;
        conflicts: typeof conflicts;
        canon: typeof canon;
        warnings: typeof warnings;
      }>(`/api/projects/${bundle.project.id}/world${sceneId}`);
      setEntities(data.entities);
      setFacts(data.facts);
      setTimeline(data.timeline);
      setConflicts(data.conflicts);
      setCanon(data.canon);
      setWarnings(data.warnings);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [bundle.project.id, ctx.selectedSceneId]);

  useEffect(() => {
    void loadWorld();
  }, [loadWorld]);

  const createEntity = async () => {
    if (!entityName.trim()) return;
    setBusy(true);
    try {
      await api(`/api/projects/${bundle.project.id}/world`, {
        method: "POST",
        json: { action: "entity", kind: entityKind, name: entityName.trim(), summary: entitySummary.trim() },
      });
      setEntityName("");
      setEntitySummary("");
      await loadWorld();
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createFact = async () => {
    if (!factForm.attribute.trim() || !factForm.value.trim()) return;
    setBusy(true);
    try {
      await api(`/api/projects/${bundle.project.id}/world`, {
        method: "POST",
        json: {
          action: "fact",
          fact: {
            subjectType: "entity",
            subjectId: factForm.subjectId,
            attribute: factForm.attribute,
            value: factForm.value,
            sourceType: factForm.sourceType,
            scopeStart: factForm.scopeStart || null,
            scopeEnd: factForm.scopeEnd || null,
            status: factForm.status,
          },
        },
      });
      setFactForm({ ...factForm, attribute: "", value: "", scopeStart: "", scopeEnd: "" });
      await loadWorld();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setFactStatus = async (id: string, status: (typeof STATUS_OPTIONS)[number]) => {
    setBusy(true);
    try {
      await api(`/api/facts/${id}`, { method: "PATCH", json: { status } });
      await loadWorld();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const addVersion = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/entities/${detail.id}`, {
        method: "POST",
        json: {
          action: "version",
          version: {
            label: versionForm.label,
            layer: versionForm.layer,
            payload: { value: versionForm.value },
            fixedTraits: ["identity", "face", "body", "birthmark"].includes(versionForm.layer),
            validFrom: versionForm.validFrom || null,
            validTo: versionForm.validTo || null,
            notes: versionForm.notes,
            approved: false,
          },
        },
      });
      setVersionForm({ ...versionForm, label: "", value: "", notes: "" });
      await loadWorld();
      const refreshed = await api<{ entity: Entity; versions: EntityVersion[] }>(`/api/entities/${detail.id}`);
      setDetail({ ...refreshed.entity, versions: refreshed.versions });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const approveVersion = async (versionId: string) => {
    setBusy(true);
    try {
      await api(`/api/entities/${detail?.id}`, { method: "POST", json: { action: "approve", versionId } });
      await loadWorld();
      if (detail) {
        const refreshed = await api<{ entity: Entity; versions: EntityVersion[] }>(`/api/entities/${detail.id}`);
        setDetail({ ...refreshed.entity, versions: refreshed.versions });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const addTimeline = async () => {
    if (!timelineForm.label.trim()) return;
    setBusy(true);
    try {
      await api(`/api/projects/${bundle.project.id}/world`, {
        method: "POST",
        json: { action: "timeline", label: timelineForm.label, storyDate: timelineForm.storyDate || null, kind: timelineForm.kind },
      });
      setTimelineForm({ label: "", storyDate: "", kind: "event" });
      await loadWorld();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const scene = bundle.scenes.find((s) => s.id === ctx.selectedSceneId) ?? null;
  const entityNameById = (id: string) => entities.find((e) => e.id === id)?.name ?? id;

  /** پرتره از میان مراجع تأییدشدهٔ همین موجودیت انتخاب می‌شود؛ هرگز تصویر تولیدشدهٔ تازه جای آن را نمی‌گیرد. */
  const portraitFor = (entityId: string) =>
    bundle.references.find((ref) => ref.status === "approved" && ref.entityIds.includes(entityId))?.thumbUrl ?? null;

  const openDetail = async (entity: EntityWithVersions) => {
    setDetail(entity);
    setProfile({ name: entity.name, summary: entity.summary });
    setDeps(null);
    try {
      const data = await api<{ dependencies: typeof deps }>(`/api/entities/${entity.id}`);
      setDeps(data.dependencies);
    } catch {
      setDeps({ scenes: [], panels: [] });
    }
  };

  const saveProfile = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/entities/${detail.id}`, { method: "PATCH", json: { name: profile.name, summary: profile.summary } });
      await loadWorld();
      await reload();
      const refreshed = await api<{ entity: Entity; versions: EntityVersion[] }>(`/api/entities/${detail.id}`);
      setDetail({ ...refreshed.entity, versions: refreshed.versions });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <ErrorNote error={error} onRetry={() => void loadWorld()} />

      <Card
        title="اطلاعات قطعی در زمان صحنه"
        actions={
          <select value={ctx.selectedSceneId ?? ""} onChange={(e) => ctx.setSelectedSceneId(e.target.value || null)} style={{ width: 240 }}>
            <option value="">— صحنه را انتخاب کنید —</option>
            {bundle.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} {s.storyDate ? `(${s.storyDate})` : ""}
              </option>
            ))}
          </select>
        }
      >
        {!scene ? (
          <p className="muted">برای دیدن اطلاعات معتبر در زمان داستان، یک صحنه انتخاب کنید.</p>
        ) : (
          <>
            <p className="small muted">
              زمان صحنه: <strong>{scene.storyDate ?? "نامشخص"}</strong>
              {scene.isFlashback ? " — فلش‌بک: وضعیت معتبر همان زمان داستان اعمال می‌شود، نه وضعیت فعلی روایت." : ""}
            </p>
            {canon?.conflicts.length ? (
              <Notice tone="bad">
                <strong>تعارض در اطلاعات قطعی:</strong>
                <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
                  {canon.conflicts.map((c, i) => (
                    <li key={i} className="small">
                      {c}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            {warnings?.conflicts.length ? (
              <Notice tone="warn">
                {warnings.conflicts.map((group, i) => (
                  <div key={i} className="small">
                    {group.map((f) => `${f.attribute}: ${f.value}`).join(" ←→ ")}
                  </div>
                ))}
              </Notice>
            ) : null}
            <div className="grid grid-2">
              {(canon?.entries ?? []).map((entry, index) => (
                <div key={index} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                  <div>
                    <strong className="small">
                      {entry.subject} / {entry.attribute}
                    </strong>
                    <div className="small">{entry.value ?? "—"}</div>
                    <div className="small muted">{entry.reason}</div>
                  </div>
                  <StatusBadge status={entry.status} />
                </div>
              ))}
            </div>
            {!canon?.entries.length ? <p className="small muted">هنوز واقعیت تأییدشده‌ای برای این صحنه ثبت نشده است.</p> : null}
          </>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="موجودیت‌های جهان داستان" actions={<Badge>{entities.length}</Badge>}>
          {loading ? <Spinner /> : null}
          {["character", "location", "object", "group", "rule"].map((kind) => {
            const list = entities.filter((e) => e.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind} style={{ marginBottom: 10 }}>
                <h4 className="small muted">{KIND_LABELS[kind]}</h4>
                <div className="dossier-grid">
                  {list.map((entity) => {
                    const approved = entity.versions.filter((v) => v.approvedAt);
                    const portrait = portraitFor(entity.id);
                    return (
                      <button key={entity.id} className="dossier" onClick={() => void openDetail(entity)}>
                        <span className="dossier-portrait">
                          {portrait ? <img src={portrait} alt={`پرترهٔ ${entity.name}`} loading="lazy" /> : <span aria-hidden>{entity.name.slice(0, 1)}</span>}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <strong>{entity.name}</strong>
                          <span className="small muted clamp-2">{entity.summary || "بدون توضیح"}</span>
                          <span className="row" style={{ gap: 4, marginTop: 4 }}>
                            <Badge tone={approved.length ? "ok" : "warn"}>{approved.length ? `${approved.length} نسخهٔ تأییدشده` : "بدون تأیید"}</Badge>
                            <Badge tone="muted">{facts.filter((fact) => fact.subjectId === entity.id).length} واقعیت</Badge>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!loading && entities.length === 0 ? <Empty title="موجودیتی ثبت نشده است." /> : null}
          <div className="sep" />
          <div className="row">
            <select value={entityKind} onChange={(e) => setEntityKind(e.target.value)} style={{ width: 120 }}>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input value={entityName} onChange={(e) => setEntityName(e.target.value)} placeholder="نام" style={{ width: 140 }} />
            <input value={entitySummary} onChange={(e) => setEntitySummary(e.target.value)} placeholder="خلاصه" />
            <Button size="sm" onClick={() => void createEntity()} disabled={busy || !entityName.trim()}>
              افزودن
            </Button>
          </div>
        </Card>

        <Card title="زمان‌بندی داستان" actions={<Badge>{timeline.length} رخداد</Badge>}>
          <p className="small muted">ترتیب فصل‌ها با ترتیب زمانی یکی نیست؛ فلش‌بک با تاریخ داستان خودش سنجیده می‌شود.</p>
          <div className="list">
            {timeline.map((event) => (
              <div key={event.id} className="list-item" style={{ cursor: "default" }}>
                <div>
                  <strong className="small">{event.label}</strong>
                  <div className="small muted">
                    {event.storyDate ?? "بدون تاریخ"} · {event.kind === "wound" ? "زخم" : event.kind === "flashback" ? "فلش‌بک" : "رخداد"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="sep" />
          <div className="row">
            <input value={timelineForm.label} onChange={(e) => setTimelineForm({ ...timelineForm, label: e.target.value })} placeholder="رخداد" />
            <input type="date" value={timelineForm.storyDate} onChange={(e) => setTimelineForm({ ...timelineForm, storyDate: e.target.value })} style={{ width: 150 }} />
            <Button size="sm" onClick={() => void addTimeline()} disabled={busy || !timelineForm.label.trim()}>
              افزودن
            </Button>
          </div>
        </Card>
      </div>

      <Card title="واقعیت‌های داستان (مرجع قطعی)" actions={<Badge>{facts.length}</Badge>}>
        <p className="small muted">
          پیشنهاد هوش مصنوعی فقط با تأیید شما به مرجع قطعی می‌رود. ویژگی‌های ثابت و وضعیت متغیر با بازهٔ اعتبار جدا می‌شوند.
        </p>
        {conflicts.length ? (
          <Notice tone="warn">
            {conflicts.map((c) => (
              <div key={c.key} className="small">
                تعارض: {c.key} — {c.facts.map((f) => f.value).join(" ←→ ")}
              </div>
            ))}
          </Notice>
        ) : null}
        <div className="grid grid-2">
          {facts.map((fact) => (
            <div key={fact.id} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
              <div>
                <strong className="small">
                  {entityNameById(fact.subjectId)} / {fact.attribute}
                </strong>
                <div className="small">{fact.value}</div>
                <div className="small muted">
                  منبع: {fact.sourceType}
                  {fact.scopeStart || fact.scopeEnd ? ` · بازه: ${fact.scopeStart ?? "…"} تا ${fact.scopeEnd ?? "…"}` : " · همیشه"}
                  {fact.createdBy === "ai" ? " · پیشنهاد AI" : ""}
                </div>
              </div>
              <div className="col" style={{ gap: 4, alignItems: "flex-end" }}>
                <StatusBadge status={fact.status} />
                <div className="row">
                  {fact.status !== "confirmed" ? (
                    <Button size="sm" onClick={() => void setFactStatus(fact.id, "confirmed")} disabled={busy}>
                      تأیید
                    </Button>
                  ) : null}
                  {fact.status !== "rejected" ? (
                    <Button size="sm" variant="ghost" onClick={() => void setFactStatus(fact.id, "rejected")} disabled={busy}>
                      رد
                    </Button>
                  ) : null}
                  {fact.status !== "retired" ? (
                    <Button size="sm" variant="ghost" onClick={() => void setFactStatus(fact.id, "retired")} disabled={busy}>
                      کنارگذاشتن
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="sep" />
        <div className="grid grid-3">
          <Field label="موضوع">
            <select value={factForm.subjectId} onChange={(e) => setFactForm({ ...factForm, subjectId: e.target.value })}>
              <option value="">— جهان داستان —</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ویژگی">
            <input value={factForm.attribute} onChange={(e) => setFactForm({ ...factForm, attribute: e.target.value })} placeholder="مثلاً زخم" />
          </Field>
          <Field label="مقدار">
            <input value={factForm.value} onChange={(e) => setFactForm({ ...factForm, value: e.target.value })} />
          </Field>
          <Field label="از تاریخ (اختیاری)">
            <input type="date" value={factForm.scopeStart} onChange={(e) => setFactForm({ ...factForm, scopeStart: e.target.value })} />
          </Field>
          <Field label="تا تاریخ (اختیاری)">
            <input type="date" value={factForm.scopeEnd} onChange={(e) => setFactForm({ ...factForm, scopeEnd: e.target.value })} />
          </Field>
          <Field label="وضعیت">
            <select value={factForm.status} onChange={(e) => setFactForm({ ...factForm, status: e.target.value as (typeof STATUS_OPTIONS)[number] })}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button variant="primary" onClick={() => void createFact()} disabled={busy || !factForm.attribute.trim() || !factForm.value.trim()}>
          ثبت واقعیت
        </Button>
      </Card>

      {detail ? (
        <Modal title={`${detail.name} — پرونده و نسخه‌ها`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-2">
            <Field label="نام">
              <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </Field>
            <Field label="توضیح کوتاه" hint="یک یا دو جمله برای شناخت سریع شخصیت یا مکان.">
              <input value={profile.summary} onChange={(e) => setProfile({ ...profile, summary: e.target.value })} />
            </Field>
          </div>
          <Button size="sm" onClick={() => void saveProfile()} disabled={busy || !profile.name.trim()}>
            ذخیرهٔ پرونده
          </Button>
          <div className="sep" />
          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            {portraitFor(detail.id) ? (
              <img src={portraitFor(detail.id)!} alt={`پرترهٔ تأییدشدهٔ ${detail.name}`} style={{ width: 120, borderRadius: 8, border: "1px solid var(--border)" }} />
            ) : (
              <div className="dossier-portrait" style={{ width: 96, height: 120 }}>
                <span aria-hidden>{detail.name.slice(0, 1)}</span>
              </div>
            )}
            <div className="grow">
              <h4>وابستگی‌ها</h4>
              {!deps ? <Spinner label="در حال خواندن وابستگی‌ها…" /> : null}
              {deps ? (
                <>
                  <p className="small muted" style={{ margin: 0 }}>
                    {deps.scenes.length} صحنه با حضور این موجودیت · {deps.panels.length} پنل در کادر
                  </p>
                  {deps.scenes.length ? (
                    <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {deps.scenes.map((item) => (
                        <button key={item.id} className="chip" onClick={() => { ctx.setSelectedSceneId(item.id); setDetail(null); }}>
                          {item.title}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="small muted">در هیچ صحنه‌ای به‌عنوان حاضر ثبت نشده است.</p>
                  )}
                </>
              ) : null}
            </div>
          </div>
          <div className="sep" />
          <div className="col">
            {detail.versions.map((version) => (
              <div key={version.id} className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div>
                  <strong className="small">
                    {LAYER_LABELS[version.layer] ?? version.layer} — {version.label || "بدون برچسب"} (v{version.version})
                  </strong>
                  <div className="small">{Object.values(version.payload).join(" · ")}</div>
                  <div className="small muted">
                    {version.fixedTraits ? "ویژگی ثابت · " : ""}
                    بازه: {version.validFrom ?? "…"} تا {version.validTo ?? "…"} · {formatDate(version.createdAt)}
                  </div>
                </div>
                <div className="col" style={{ alignItems: "flex-end", gap: 4 }}>
                  <Badge tone={version.approvedAt ? "ok" : "warn"}>{version.approvedAt ? "تأییدشده" : "پیش‌نویس"}</Badge>
                  {!version.approvedAt ? (
                    <Button size="sm" onClick={() => void approveVersion(version.id)} disabled={busy}>
                      تأیید نسخه
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="sep" />
          <h4>نسخهٔ تازه</h4>
          <div className="grid grid-3">
            <Field label="لایه">
              <select value={versionForm.layer} onChange={(e) => setVersionForm({ ...versionForm, layer: e.target.value })}>
                {Object.entries(LAYER_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="برچسب">
              <input value={versionForm.label} onChange={(e) => setVersionForm({ ...versionForm, label: e.target.value })} placeholder="مثلاً لباس زمستانی" />
            </Field>
            <Field label="مقدار / توضیح">
              <input value={versionForm.value} onChange={(e) => setVersionForm({ ...versionForm, value: e.target.value })} placeholder="مثلاً پالتوی خاکی" />
            </Field>
            <Field label="از تاریخ داستان">
              <input type="date" value={versionForm.validFrom} onChange={(e) => setVersionForm({ ...versionForm, validFrom: e.target.value })} />
            </Field>
            <Field label="تا تاریخ داستان">
              <input type="date" value={versionForm.validTo} onChange={(e) => setVersionForm({ ...versionForm, validTo: e.target.value })} />
            </Field>
            <Field label="یادداشت">
              <input value={versionForm.notes} onChange={(e) => setVersionForm({ ...versionForm, notes: e.target.value })} />
            </Field>
          </div>
          <Button variant="primary" onClick={() => void addVersion()} disabled={busy || !versionForm.value.trim()}>
            افزودن نسخه (پیش‌نویس)
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}
