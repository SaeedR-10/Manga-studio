import { splitSceneIntoPanels } from "./adaptation";
import { defaultAdaptationId, createChapter, createProject, createScene, saveSceneText } from "./repo/projects";
import {
  addEntityVersion,
  approveEntityVersion,
  createEntity,
  createFact,
  createStyle,
  createTimelineEvent,
  saveSceneState,
  upsertKnowledge,
} from "./repo/world";
import { createReference } from "./repo/refs";
import { createPanels } from "./repo/panels";
import { autoLayout, ensureDoc } from "./repo/layout";
import { saveImage } from "./storage";
import { getScene } from "./repo/projects";

/**
 * پروژهٔ نمونهٔ فارسی: دو شخصیت، یک مکان، یک شیء، یک صحنهٔ ۱۲ پنلی با
 * گفت‌وگو و حرکت، و فلش‌بکی که پیش از ایجاد زخم رخ می‌دهد.
 *
 * هیچ درخواست AI پولی در ساخت نمونه ارسال نمی‌شود. تصویر نمونهٔ کوچکی که
 * ساخته می‌شود صریحاً «جای‌نگهدار» است و مرجع واقعی نیست.
 */

const PRESENT_TEXT = `باران روی سقف حلبی بازار می‌کوبید و چراغ نفتی کهنه در دست آریا لرزید.
آریا پالتوی خاکی‌اش را جمع کرد و به سایهٔ انتهای راهرو نگاه کرد.
نیلا زیر طاق ایستاده بود و چراغ دیگرش را بالا گرفت.
«دو سال بود که برنگشتی.»
آریا جوابی نداشت؛ فقط سکوت کرد و به دستهٔ چاقو در جیبش فکر کرد.
نیلا قدمی جلو آمد و گفت: «می‌گفتند در انبار سوختی.»
«مرده بودم، ولی نه آن‌طور که می‌گویند.»
باد لامپ‌ها را تکان داد و سایهٔ دو نفر روی دیوار نمناک کش آمد.
نیلا به بازوی راست او نگاه کرد و باند تازه را دید.
«این زخم را از کجا آوردی؟»
آریا آستینش را پایین کشید و گفت: «از جایی که نباید می‌رفتم.»
چراغ نفتی میانشان می‌سوخت و بوی نفت توی هوا سنگین بود.
نیلا آهسته گفت: «اگر دنبال نقشهٔ بازار هستی، دیگر روی کاغذ نیست.»
آریا سر بلند کرد و در چشم‌های او دنبال دروغ گشت.
«پس کجاست؟»
نیلا به تاریکی اشاره کرد و پاسخ داد: «جایی که چراغت نمی‌رسد.»
صدای قدم‌های نگهبان از دور آمد و هر دو هم‌زمان خاموش شدند.`;

const FLASHBACK_TEXT = `سه ماه پیش، همان بازار، ولی آفتاب روی سنگ‌فرش‌ها بود.
آریا با پالتوی خاکی و بی‌زخم از میان بساط دست‌فروش‌ها گذشت.
نیلا پشت دکهٔ ادویه ایستاده بود و می‌خندید.
«تو هنوز همان بچه‌ای هستی که از دیوار می‌پرید.»
آریا شانه بالا انداخت و چراغ نفتی را روی پیشخوان گذاشت.
«این را برایت آوردم؛ به‌جای آن یکی که شکستی.»
نیلا دستش را روی چراغ گذاشت و گفت: «پس فردا شب، انبار.»
آریا سر تکان داد و رفت؛ هیچ زخمی روی بازوی راستش نبود.`;

export interface SampleResult {
  projectId: string;
  title: string;
}

export function createSampleProject(): SampleResult {
  const project = createProject({
    title: "دریا و سایه",
    subtitle: "نمونهٔ فارسی — دو شخصیت، یک مکان، یک شیء",
    description:
      "پروژهٔ نمونهٔ استودیوی روایت. فلش‌بک پیش از ایجاد زخم رخ می‌دهد؛ پنل‌ها پیشنهاد محلی (بدون AI) هستند و باید بازبینی شوند.",
    publishFormat: "vertical",
  });
  const projectId = project.id;

  createStyle({
    projectId,
    name: "سیاه‌قلم سرد",
    description: "مانهوای سیاه‌وسفید با شب‌پرده‌های خاکستری و بافت مرکب",
    palette: "خاکستری سرد، سیاه، سفید کاغذ",
    linework: "خطوط تمیز با سایه‌پردازی هاشور",
    notes: "فضای بارانی و نور کم؛ پرهیز از رنگ‌های اشباع.",
    isDefault: true,
  });

  const aria = createEntity({
    projectId,
    kind: "character",
    name: "آریا",
    summary: "پسر بازگشته از انبار سوخته؛ آرام، کم‌حرف و مراقب.",
    details: { role: "شخصیت اصلی", age: 27 },
  });
  const nila = createEntity({
    projectId,
    kind: "character",
    name: "نیلا",
    summary: "دختر دکهٔ ادویه؛ تیزبین و صریح، صاحب بخشی از نقشهٔ بازار.",
    details: { role: "شخصیت مقابل", age: 24 },
  });
  const market = createEntity({
    projectId,
    kind: "location",
    name: "بازار نمناک",
    summary: "بازار سرپوشیدهٔ قدیمی با راهروهای باریک، سقف حلبی و چراغ‌های نفتی.",
    details: { features: "طاق آجری، دیوار نمناک، دکهٔ ادویه، انبار انتهایی" },
  });
  const lamp = createEntity({
    projectId,
    kind: "object",
    name: "چراغ نفتی",
    summary: "چراغ برنجی کهنه با شیشهٔ ترک‌خورده؛ نشانهٔ آشنایی آریا و نیلا.",
    details: { scale: "به اندازهٔ یک کتاب جیبی" },
  });

  // نسخهٔ هویت (ثابت) و لباس (متغیر)
  const identity = addEntityVersion({
    entityId: aria.id,
    layer: "identity",
    label: "هویت ثابت",
    payload: {
      face: "چشم‌های خاکستری، ابروی چپ با بریدگی کوچک",
      body: "قد متوسط، شانهٔ راست کمی افتاده",
      birthmark: "خال ریز کنار گوش راست",
    },
    fixedTraits: true,
    approved: true,
  });
  approveEntityVersion(identity.id);
  const coat = addEntityVersion({
    entityId: aria.id,
    layer: "clothing",
    label: "پالتوی خاکی",
    payload: { clothing: "پالتوی خاکی بلند، شال گردن تیره" },
    validFrom: "2025-06-01",
    validTo: "2026-02-19",
    approved: true,
  });
  approveEntityVersion(coat.id);
  const shirt = addEntityVersion({
    entityId: aria.id,
    layer: "clothing",
    label: "پیراهن آستین‌کوتاه با باند",
    payload: { clothing: "پیراهن آستین‌کوتاه تیره، باند سفید روی بازوی راست" },
    validFrom: "2026-02-20",
    approved: true,
  });
  approveEntityVersion(shirt.id);

  // واقعیت‌های قطعی با بازهٔ اعتبار
  const faceFact = createFact({
    projectId,
    subjectId: aria.id,
    attribute: "چهره",
    value: "چشم خاکستری و بریدگی کوچک ابروی چپ",
    sourceType: "user_decision",
    sourceRef: "یادداشت نویسنده",
    status: "confirmed",
    createdBy: "user",
  });
  createFact({
    projectId,
    subjectId: aria.id,
    attribute: "زخم",
    value: "زخم بخیه‌خورده روی بازوی راست",
    sourceType: "user_decision",
    sourceRef: "فصل ۱ — پس از انبار",
    status: "confirmed",
    scopeStart: "2026-02-20",
    createdBy: "user",
  });
  const secretFact = createFact({
    projectId,
    subjectId: nila.id,
    attribute: "راز",
    value: "برادرش را زنده دیده و به کسی نگفته است",
    sourceType: "ai_suggestion",
    sourceRef: "پیشنهاد نمونه (تأییدنشده)",
    status: "proposed",
    createdBy: "ai",
  });
  upsertKnowledge({
    projectId,
    characterId: nila.id,
    factId: secretFact.id,
    knowledge: "knows",
    note: "نیلا خودش شاهد بوده؛ اما این راز پیش از افشا در دیالوگ نمی‌آید.",
  });
  upsertKnowledge({
    projectId,
    characterId: aria.id,
    factId: secretFact.id,
    knowledge: "unaware",
    note: "آریا تا صحنهٔ افشا از این موضوع بی‌خبر است.",
  });
  upsertKnowledge({
    projectId,
    characterId: nila.id,
    factId: faceFact.id,
    knowledge: "knows",
  });

  const chapter1 = createChapter(projectId, "بازگشت");
  const scene1 = createScene({ chapterId: chapter1.id, title: "بازار شبانه", storyDate: "2026-03-02" });
  saveSceneText({ sceneId: scene1.id, text: PRESENT_TEXT, reason: "seed" });
  const savedScene = getScene(scene1.id)!;
  saveSceneState({
    sceneId: scene1.id,
    locationId: market.id,
    presentEntities: [aria.id, nila.id],
  });

  const chapter2 = createChapter(projectId, "آن شب در انبار");
  const flashScene = createScene({
    chapterId: chapter2.id,
    title: "آفتاب روی سنگ‌فرش",
    storyDate: "2026-01-12",
    isFlashback: true,
  });
  saveSceneText({ sceneId: flashScene.id, text: FLASHBACK_TEXT, reason: "seed" });
  saveSceneState({ sceneId: flashScene.id, locationId: market.id, presentEntities: [aria.id, nila.id] });

  createTimelineEvent({
    projectId,
    label: "آریا چراغ نفتی را به نیلا می‌دهد",
    storyDate: "2026-01-12",
    sceneId: flashScene.id,
    kind: "flashback",
  });
  createTimelineEvent({
    projectId,
    label: "زخمی شدن آریا در انبار",
    storyDate: "2026-02-20",
    kind: "wound",
    note: "خارج از صحنه؛ در فلش‌بک نباید دیده شود.",
  });
  createTimelineEvent({
    projectId,
    label: "بازگشت آریا به بازار",
    storyDate: "2026-03-02",
    sceneId: scene1.id,
    kind: "event",
  });

  const adaptationId = defaultAdaptationId(projectId);
  const proposals = splitSceneIntoPanels({
    text: PRESENT_TEXT,
    characters: [
      { id: aria.id, name: "آریا" },
      { id: nila.id, name: "نیلا" },
    ],
    locationName: "بازار نمناک",
    target: 12,
    isFlashback: false,
    storyDate: "2026-03-02",
  });
  const panels = createPanels({
    projectId,
    adaptationId,
    sceneId: savedScene.id,
    sourceSceneVersionId: savedScene.currentVersionId,
    proposals,
    identitySnapshot: {
      note: "پنل‌ها با تقسیم‌بندی محلی ساخته شده‌اند (بدون AI) و باید بازبینی شوند.",
      canonSource: "snapshot-at-creation",
    },
  });

  // یک مرجع جای‌نگهدار که صریحاً «تصویر واقعی نیست» برچسب دارد.
  try {
    const placeholder = buildPlaceholderPng();
    const asset = saveImage({
      buffer: placeholder,
      filename: "sample-placeholder.png",
      mime: "image/png",
      kind: "reference",
      width: 320,
      height: 320,
    });
    createReference({
      projectId,
      assetId: asset.id,
      title: "نمونهٔ جای‌نگهدار — تصویر واقعی نیست",
      description:
        "این فایل فقط برای آزمون مسیر کتابخانهٔ مراجع ساخته شده و تصویر AI یا مرجع هنری واقعی نیست. پیش از استفاده در تولید، تأیید یا حذف کنید.",
      origin: "imported",
      licenseNote: "ساخته‌شده توسط برنامه برای آزمون",
      entityIds: [aria.id],
      roles: ["identity"],
      tags: ["نمونه", "جای‌نگهدار"],
      status: "draft",
    });
  } catch {
    // نمونهٔ تصویری اختیاری است و نبودش مانع ساخت نمونهٔ متنی نیست.
  }

  const doc = ensureDoc(projectId, "vertical");
  autoLayout(
    doc.id,
    panels.map((p) => p.id),
  );

  return { projectId, title: project.title };
}

/**
 * PNG سادهٔ ۳۲۰×۳۲۰ با نوارهای خاکستری؛ بدون وابستگی بومی.
 * متن روی تصویر نوشته نمی‌شود تا ادعای خروجی هنری نداشته باشد.
 */
function buildPlaceholderPng(): Buffer {
  const width = 320;
  const height = 320;
  const raw: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor((x + y) / 24) % 2 === 0;
      const value = stripe ? 208 : 96;
      row[1 + x * 3] = value;
      row[2 + x * 3] = value;
      row[3 + x * 3] = value;
    }
    raw.push(row);
  }
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const idat = zlib.deflateSync(Buffer.concat(raw));
  const crcTable = buildCrcTable();
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const typeBuf = Buffer.from(type, "ascii");
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([typeBuf, data])) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
