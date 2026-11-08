/** انواع مشترک رابط کاربر و API. */

export type PublishFormat = "vertical" | "page";

export interface ProjectSettings {
  text: { provider: string; model: string };
  image: { provider: string; model: string };
  caps: {
    generationsPerPanel: number;
    reviewsPerPanel: number;
    chapterBudgetUsd: number | null;
    /** وقتی هزینهٔ یک درخواست نامشخص است، آیا پذیرش آن زیر سقف فصل مجاز است؟ */
    unknownCostPolicy: "block" | "allow";
  };
  readingOrder: "rtl" | "ltr";
  adaptation: { panelsPerScene: number };
}

export interface Project {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  language: string;
  publishFormat: PublishFormat;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  id: string;
  projectId: string;
  position: number;
  title: string;
  summary: string;
  storyDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: string;
  projectId: string;
  chapterId: string;
  position: number;
  title: string;
  text: string;
  objective: string;
  status: string;
  storyDate: string | null;
  isFlashback: boolean;
  wordCount: number;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneVersion {
  id: string;
  sceneId: string;
  version: number;
  text: string;
  hash: string;
  wordCount: number;
  reason: string;
  createdAt: string;
}

export type EntityKind = "character" | "location" | "object" | "group" | "rule";

export interface Entity {
  id: string;
  projectId: string;
  kind: EntityKind;
  name: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EntityVersion {
  id: string;
  entityId: string;
  version: number;
  label: string;
  layer: string;
  payload: Record<string, unknown>;
  fixedTraits: boolean;
  validFrom: string | null;
  validTo: string | null;
  notes: string;
  createdAt: string;
  approvedAt: string | null;
}

export type FactStatus = "proposed" | "confirmed" | "rejected" | "retired";

export interface Fact {
  id: string;
  projectId: string;
  subjectType: "entity" | "project";
  subjectId: string;
  attribute: string;
  value: string;
  sourceType: string;
  sourceRef: string;
  status: FactStatus;
  scopeStart: string | null;
  scopeEnd: string | null;
  conflictGroup: string | null;
  resolutionNote: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceAsset {
  id: string;
  projectId: string;
  assetId: string;
  title: string;
  description: string;
  origin: "local_upload" | "ai_output" | "imported";
  licenseNote: string;
  status: "draft" | "approved" | "rejected" | "archived";
  version: number;
  supersedesId: string | null;
  entityIds: string[];
  roles: string[];
  tags: string[];
  approvedAt: string | null;
  /** بازهٔ اعتبار این مرجع در زمان داستان؛ null یعنی بی‌کران */
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  thumbUrl: string;
}

export type ShotSize = "wide" | "medium" | "close" | "extreme_close" | "over_shoulder" | "detail";
export type CameraAngle = "eye" | "low" | "high" | "birds_eye" | "dutch";

export interface PanelCharacter {
  entityId: string | null;
  name: string;
  position: string;
  gaze: string;
  emotion: string;
  clothing: string;
  identityNote: string;
}

export interface PanelDialogue {
  speaker: string;
  text: string;
  kind: "dialogue" | "narration" | "thought" | "sfx";
}

export interface Panel {
  id: string;
  projectId: string;
  adaptationId: string;
  sceneId: string;
  position: number;
  title: string;
  sourceSceneVersionId: string | null;
  sourceExcerpt: string;
  narrativeGoal: string;
  action: string;
  characters: PanelCharacter[];
  locationId: string | null;
  timeLabel: string;
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  gazeDirection: string;
  movement: string;
  emotion: string;
  lighting: string;
  costumes: string;
  props: string;
  dialogue: PanelDialogue[];
  styleProfileId: string | null;
  referencesUsed: string[];
  identitySnapshot: Record<string, unknown>;
  status: string;
  needsReview: boolean;
  reviewReason: string;
  currentTakeId: string | null;
  imageAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PanelTake {
  id: string;
  panelId: string;
  requestId: string;
  assetId: string;
  variant: number;
  status: "candidate" | "accepted" | "rejected" | "superseded";
  seed: string | null;
  /** برای خروجی اصلاح ناحیه‌ای: مرجع خروجی مبدأ و ماسک استفاده‌شده */
  sourceTakeId: string | null;
  maskAssetId: string | null;
  editKind: string | null;
  createdAt: string;
  acceptedAt: string | null;
  imageUrl: string;
}

export type AiJobStatus = "queued" | "sending" | "processing" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface AiRequest {
  id: string;
  projectId: string;
  panelId: string | null;
  role: string;
  provider: string;
  model: string;
  promptVersion: number | null;
  status: AiJobStatus;
  attempts: number;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  promptText: string;
  inputs: Record<string, unknown>;
  costEstimate: { usd: number | null; basis: string; source?: string };
  costReported: Record<string, unknown>;
  costComputed: { usd: number | null; basis?: string };
  createdAt: string;
  finishedAt: string | null;
  takes?: PanelTake[];
  parsed?: unknown;
}

export interface ReviewIssue {
  id: string;
  kind: string;
  severity: "low" | "medium" | "high";
  description: string;
  referenceId: string | null;
  evidence: string;
  confidence: string;
  suggestion: string;
  evaluable: boolean;
  decision: "pending" | "accepted" | "rejected" | "intentional";
  decisionNote: string;
}

export interface ReviewReport {
  id: string;
  panelId: string;
  summary: string;
  createdAt: string;
  issues: ReviewIssue[];
}

export interface Job {
  id: string;
  projectId: string;
  type: string;
  status: AiJobStatus;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginationDoc {
  id: string;
  projectId: string;
  format: PublishFormat;
  title: string;
  pageWidth: number;
  pageHeight: number;
  gap: number;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Placement {
  id: string;
  docId: string;
  panelId: string;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  readingIndex: number;
}

export interface TextLayer {
  id: string;
  docId: string;
  panelId: string | null;
  placementId: string | null;
  kind: "dialogue" | "narration" | "thought" | "sfx" | "caption";
  speaker: string;
  body: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  direction: "rtl" | "ltr";
  tail: string;
  z: number;
}
