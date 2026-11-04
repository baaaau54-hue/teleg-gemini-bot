import { GoogleGenAI } from "@google/genai";
import ExcelJS from "exceljs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Telegraf } from "telegraf";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
const MAX_FILE_BYTES = Math.min(Math.max(Number.parseInt(process.env.MAX_FILE_BYTES || "15000000", 10) || 15000000, 1024), 18000000);
const MAX_TELEGRAM_TEXT = 3900;
const LOG_LIMIT = 30;
const memoryStore = new Map();
const FEATURE_NAMES = new Set(["text", "image", "document", "audio", "video", "search", "image_generation", "tables"]);
let bot;
let initialization;

function redisEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Redis request failed (${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error("Redis command failed");
  return payload.result;
}

const key = (kind, id = "global") => `teleg-gemini:${kind}:${id}`;

async function readJson(storageKey, fallback) {
  if (redisEnabled()) {
    try {
      const value = await redisCommand("GET", storageKey);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.error("Redis read failed:", error.message);
    }
  }
  return memoryStore.get(storageKey) ?? fallback;
}

async function writeJson(storageKey, value) {
  if (redisEnabled()) {
    try {
      await redisCommand("SET", storageKey, JSON.stringify(value));
      return;
    } catch (error) {
      console.error("Redis write failed:", error.message);
    }
  }
  memoryStore.set(storageKey, value);
}

async function removeKey(storageKey) {
  if (redisEnabled()) {
    try { await redisCommand("DEL", storageKey); }
    catch (error) { console.error("Redis delete failed:", error.message); }
  }
  memoryStore.delete(storageKey);
}

function encryptApiKey(apiKey) {
  const secret = process.env.USER_API_KEYS_ENCRYPTION_KEY;
  if (!secret) throw new Error("المشرف لم يفعّل تشفير مفاتيح المستخدمين بعد.");
  const encryptionKey = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
}

function decryptApiKey(record) {
  const secret = process.env.USER_API_KEYS_ENCRYPTION_KEY;
  if (!secret) throw new Error("مفتاح تشفير مفاتيح المستخدمين غير مضبوط في الخادم.");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
}

async function aiForUser(userId) {
  const encrypted = await readJson(key("user-api-key", userId), null);
  if (encrypted) return new GoogleGenAI({ apiKey: decryptApiKey(encrypted) });
  if (!process.env.GEMINI_API_KEY) throw new Error("لا يوجد مفتاح Gemini. أضف مفتاحك عبر /apikey set <مفتاح> أو تواصل مع المشرف.");
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function getUserId(ctx) { return String(ctx.from?.id || ctx.chat?.id || "unknown"); }
function adminIds() { return new Set((process.env.BOT_ADMIN_IDS || "").split(",").map((id) => id.trim()).filter(Boolean)); }
function isAdmin(ctx) { return adminIds().has(getUserId(ctx)); }

async function isAllowed(ctx) {
  const id = getUserId(ctx);
  if (isAdmin(ctx)) return true;
  if (await readJson(key("blocked", id), false)) return false;
  if ((process.env.BOT_ACCESS_MODE || "open") !== "allowlist") return true;
  const allowed = (process.env.BOT_ALLOWED_USER_IDS || "").split(",").map((value) => value.trim());
  return allowed.includes(id) || await readJson(key("allowed", id), false);
}

async function record(userId, entry) {
  const storageKey = key("logs", userId);
  const logs = await readJson(storageKey, []);
  logs.push({ at: new Date().toISOString(), ...entry });
  await writeJson(storageKey, logs.slice(-LOG_LIMIT));
}

function mimeFromName(name = "") {
  const ext = name.toLowerCase().split(".").pop();
  return ({ pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" })[ext];
}

function mediaFromMessage(message) {
  if (message.photo?.length) return { file: message.photo.at(-1), type: "image", mime: "image/jpeg", name: "photo.jpg" };
  if (message.document) { const file = message.document; return { file, type: "document", mime: file.mime_type || mimeFromName(file.file_name) || "application/octet-stream", name: file.file_name || "document" }; }
  if (message.audio) return { file: message.audio, type: "audio", mime: message.audio.mime_type || "audio/mpeg", name: message.audio.file_name || "audio" };
  if (message.voice) return { file: message.voice, type: "audio", mime: message.voice.mime_type || "audio/ogg", name: "voice.ogg" };
  if (message.video) return { file: message.video, type: "video", mime: message.video.mime_type || "video/mp4", name: message.video.file_name || "video.mp4" };
  if (message.animation) return { file: message.animation, type: "video", mime: message.animation.mime_type || "video/mp4", name: message.animation.file_name || "animation.mp4" };
  if (message.video_note) return { file: message.video_note, type: "video", mime: "video/mp4", name: "video-note.mp4" };
  return null;
}

function allowedMime(mime) {
  return mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || ["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"].includes(mime);
}

async function createMediaInput(ctx, media) {
  if (Number(media.file.file_size || 0) > MAX_FILE_BYTES) throw new Error(`حجم الملف يتجاوز الحد (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  if (!allowedMime(media.mime)) throw new Error("نوع الملف غير مدعوم. أرسل صورة أو PDF أو ملفًا نصيًا أو صوتًا أو فيديو.");
  const response = await fetch(await ctx.telegram.getFileLink(media.file.file_id));
  if (!response.ok) throw new Error("تعذّر تنزيل الملف من Telegram.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`حجم الملف يتجاوز الحد (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  if (media.mime.startsWith("text/") || ["application/json", "application/xml", "text/xml"].includes(media.mime)) return { text: `محتوى الملف ${media.name}:\n${bytes.toString("utf8").slice(0, 100000)}` };
  return { type: media.type, data: bytes.toString("base64"), mime_type: media.mime };
}

function outputText(interaction) {
  if (interaction.output_text) return interaction.output_text;
  return (interaction.outputs || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n").trim();
}

function chunks(text) {
  const result = []; let rest = String(text || "").trim();
  while (rest.length > MAX_TELEGRAM_TEXT) { let at = rest.lastIndexOf("\n", MAX_TELEGRAM_TEXT); if (at < MAX_TELEGRAM_TEXT / 2) at = MAX_TELEGRAM_TEXT; result.push(rest.slice(0, at)); rest = rest.slice(at).trimStart(); }
  if (rest) result.push(rest);
  return result.length ? result : ["لم أتمكن من إنشاء رد."];
}
async function replyText(ctx, text) { for (const part of chunks(text)) await ctx.reply(part); }
function validModel(model) { return typeof model === "string" && model.length <= 100 && /^[a-zA-Z0-9._:-]+$/.test(model); }

async function runPrompt(ctx, { prompt, media, customPrompt = "", logKind = "text" }) {
  const userId = getUserId(ctx);
  const settings = await readJson(key("settings", userId), {});
  const global = await readJson(key("config"), { features: {} });
  const features = global.features || {};
  const requestedFeature = media?.type || "text";
  if (features[requestedFeature] === false) throw new Error(`المشرف عطّل ميزة ${requestedFeature}.`);
  if (settings.search && features.search === false) throw new Error("البحث معطّل من قبل المشرف.");
  const model = settings.model || global.defaultModel || DEFAULT_MODEL;
  const instructions = [settings.systemPrompt, customPrompt].filter(Boolean).join("\n\n");
  const input = [{ type: "text", text: [instructions ? `تعليمات إضافية:\n${instructions}` : "", prompt || "أجب عن الملف المرفق."].filter(Boolean).join("\n\n") }];
  if (media) {
    const part = await createMediaInput(ctx, media);
    if (part.text) input[0].text += `\n\n${part.text}`;
    else input.push(part);
  }
  const request = { model, input };
  if (settings.memory !== false && settings.previousInteractionId) request.previous_interaction_id = settings.previousInteractionId;
  if (settings.search && features.search !== false) request.tools = [{ type: "google_search" }];
  const interaction = await (await aiForUser(userId)).interactions.create(request);
  const answer = outputText(interaction);
  if (!answer) throw new Error("لم يرجع Gemini نصًا. تحقق من صلاحيات النموذج أو الملف.");
  await replyText(ctx, answer);
  if (settings.memory !== false && interaction.id) { settings.previousInteractionId = interaction.id; await writeJson(key("settings", userId), settings); }
  await record(userId, { kind: logKind, model, search: Boolean(settings.search), summary: prompt.slice(0, 100), status: "ok" });
}

function parseJsonResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("لم أستطع تحويل نتيجة Gemini إلى جدول. أعد صياغة الطلب.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function createTable(ctx, prompt) {
  const userId = getUserId(ctx);
  const settings = await readJson(key("settings", userId), {});
  const config = await readJson(key("config"), { features: {} });
  if (config.features?.tables === false) throw new Error("المشرف عطّل إنشاء الجداول.");
  const instruction = `حوّل طلب المستخدم إلى بيانات جدول. أرجع JSON صالحًا فقط بهذا الشكل: {"title":"عنوان","headers":["عمود1"],"rows":[["قيمة"]]}. لا تضع Markdown أو نصًا خارج JSON. الحد الأقصى 15 عمودًا و100 صف. إذا كان الطلب يطلب بيانات واقعية حديثة ولا يوجد بحث مفعّل، اذكر ذلك في title ولا تختلق مصادر. طلب المستخدم: ${prompt}`;
  const request = { model: settings.model || config.defaultModel || DEFAULT_MODEL, input: instruction };
  if (settings.memory !== false && settings.previousInteractionId) request.previous_interaction_id = settings.previousInteractionId;
  if (settings.search && config.features?.search !== false) request.tools = [{ type: "google_search" }];
  const interaction = await (await aiForUser(userId)).interactions.create(request);
  const table = parseJsonResponse(outputText(interaction));
  if (!Array.isArray(table.headers) || table.headers.length < 1 || table.headers.length > 15 || !Array.isArray(table.rows) || table.rows.length > 100) throw new Error("بيانات الجدول غير صالحة أو تجاوزت الحد.");
  const headers = table.headers.map((value) => String(value).slice(0, 100));
  const rows = table.rows.map((row) => headers.map((_, index) => String(Array.isArray(row) ? row[index] ?? "" : "").slice(0, 1000)));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Telegram Gemini Bot";
  const sheet = workbook.addWorksheet(String(table.title || "الجدول").slice(0, 31));
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.columns = headers.map((header, index) => ({ key: `c${index}`, width: Math.min(32, Math.max(12, header.length + 2)) }));
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const previewRows = [headers, ...rows.slice(0, 8)].map((row) => row.join(" | "));
  await ctx.reply(`📊 ${String(table.title || "الجدول")}\n${previewRows.join("\n")}${rows.length > 8 ? `\n… و${rows.length - 8} صفوف أخرى في ملف Excel.` : ""}`);
  await ctx.replyWithDocument({ source: buffer, filename: "gemini-table.xlsx" }, { caption: `${String(table.title || "الجدول").slice(0, 900)} — ملف Excel قابل للتنزيل والتعديل` });
  if (settings.memory !== false && interaction.id) { settings.previousInteractionId = interaction.id; await writeJson(key("settings", userId), settings); }
  await record(userId, { kind: "table", model: request.model, summary: prompt.slice(0, 100), status: "ok" });
}

async function createImage(ctx, prompt) {
  if (!prompt) throw new Error("اكتب وصف الصورة بعد الأمر. مثال: /image مدينة مستقبلية وقت الغروب");
  const userId = getUserId(ctx);
  const config = await readJson(key("config"), { features: {} });
  if (config.features?.image_generation === false) throw new Error("المشرف عطّل إنشاء الصور.");
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
  const interaction = await (await aiForUser(userId)).interactions.create({ model, input: prompt, response_modalities: ["image", "text"] });
  const outputs = interaction.outputs || [];
  const image = outputs.find((item) => item.type === "image" && item.data);
  if (!image) {
    const text = outputText(interaction);
    throw new Error(text ? `لم يرجع النموذج صورة. رده: ${text.slice(0, 500)}` : "لم يرجع النموذج صورة. تحقق من GEMINI_IMAGE_MODEL وصلاحية المفتاح.");
  }
  const buffer = Buffer.from(image.data, "base64");
  const mime = image.mime_type || "image/png";
  const extension = mime.includes("jpeg") ? "jpg" : mime.split("/")[1] || "png";
  await ctx.replyWithPhoto({ source: buffer, filename: `generated-image.${extension}` }, { caption: outputText(interaction).slice(0, 900) || prompt.slice(0, 900) });
  await record(userId, { kind: "image_generation", model, summary: prompt.slice(0, 100), status: "ok" });
}

function adminOnly(ctx) { return isAdmin(ctx) ? null : "هذا الأمر للمشرف فقط."; }

async function initialize() {
  if (bot) return;
  if (initialization) return initialization;
  initialization = (async () => {
    if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN environment variable");
    bot = new Telegraf(process.env.BOT_TOKEN);
    bot.use(async (ctx, next) => {
      if (!ctx.from) return;
      if (!(await isAllowed(ctx))) { if (ctx.message) await ctx.reply("ليس لديك صلاحية استخدام هذا البوت."); return; }
      return next();
    });

    bot.start((ctx) => ctx.reply("أهلًا! أرسل نصًا أو صورة أو PDF أو صوتًا أو فيديو. استخدم /help للأوامر."));
    bot.help((ctx) => ctx.reply("/settings /model /system /memory /search /reset /history\n/image <وصف> لإنشاء صورة\n/table <طلب> لإنشاء جدول Excel\n/apikey set <مفتاح> — استخدام مفتاح Gemini الشخصي\nالمشرف: /admin /allow /deny /defaultmodel /feature /custom"));

    bot.command("apikey", async (ctx) => {
      if (ctx.chat?.type !== "private") return ctx.reply("لأمانك، أرسل أوامر المفاتيح في محادثة خاصة مع البوت.");
      const message = ctx.message.text || "";
      const match = message.match(/^\/apikey(?:@\w+)?\s+(set)\s+(\S+)\s*$/i);
      if (match) {
        const apiKey = match[2];
        try {
          const encrypted = encryptApiKey(apiKey);
          await writeJson(key("user-api-key", getUserId(ctx)), encrypted);
          try { await ctx.deleteMessage(); } catch { /* Telegram may not permit deletion; never log the key. */ }
          return ctx.reply("حُفظ مفتاح Gemini الشخصي مشفّرًا. احذف الرسالة من سجل المحادثة لديك إن بقيت ظاهرة. لا تشاركه مع أحد.");
        } catch (error) {
          try { await ctx.deleteMessage(); } catch { /* best effort */ }
          return ctx.reply(error.message.startsWith("المشرف") ? error.message : "تعذر حفظ المفتاح. تأكد من إعداد Redis وتشفير مفاتيح المستخدمين.");
        }
      }
      const action = message.match(/^\/apikey(?:@\w+)?\s+(status|delete)\s*$/i)?.[1]?.toLowerCase();
      if (action === "status") {
        const exists = Boolean(await readJson(key("user-api-key", getUserId(ctx)), null));
        return ctx.reply(exists ? "لديك مفتاح Gemini شخصي محفوظ ومشفّر." : `لا يوجد مفتاح شخصي. سيستخدم البوت ${process.env.GEMINI_API_KEY ? "مفتاح الخدمة الافتراضي" : "ولا يوجد مفتاح متاح"}.`);
      }
      if (action === "delete") {
        await removeKey(key("user-api-key", getUserId(ctx)));
        return ctx.reply("حُذف مفتاحك الشخصي. سيستخدم البوت مفتاح الخدمة الافتراضي إن كان مضبوطًا.");
      }
      await ctx.reply("الاستخدام في المحادثة الخاصة فقط:\n/apikey set <مفتاحك>\n/apikey status\n/apikey delete\nمفتاحك لا يظهر للمستخدمين الآخرين، ويُخزّن مشفّرًا عند إعداد المشرف للتشفير وRedis.");
    });

    bot.command("image", async (ctx) => {
      try { await ctx.sendChatAction("upload_photo"); await createImage(ctx, ctx.message.text.replace(/^\/image(?:@\w+)?\s*/i, "").trim()); }
      catch (error) { console.error("Image generation failed:", error.message); await ctx.reply(error.message.startsWith("اكتب") || error.message.startsWith("المشرف") ? error.message : "تعذر إنشاء الصورة. تحقق من صلاحية نموذج الصور ومفتاح Gemini في إعداداتك، ثم راجع سجلات Vercel."); await record(getUserId(ctx), { kind: "image_generation", summary: (ctx.message.text || "").slice(0, 100), status: "error" }); }
    });

    bot.command("table", async (ctx) => {
      try { await ctx.sendChatAction("typing"); const prompt = ctx.message.text.replace(/^\/table(?:@\w+)?\s*/i, "").trim(); if (!prompt) return ctx.reply("الاستخدام: /table <صف الجدول الذي تريده>"); await createTable(ctx, prompt); }
      catch (error) { console.error("Table creation failed:", error.message); await ctx.reply(error.message.startsWith("المشرف") || error.message.startsWith("بيانات") || error.message.startsWith("لم أستطع") ? error.message : "تعذر إنشاء الجدول. جرّب طلبًا أوضح، ثم راجع سجلات Vercel."); await record(getUserId(ctx), { kind: "table", summary: (ctx.message.text || "").slice(0, 100), status: "error" }); }
    });

    bot.command("settings", async (ctx) => {
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      const global = await readJson(key("config"), { features: {} });
      const personalKey = Boolean(await readJson(key("user-api-key", getUserId(ctx)), null));
      await ctx.reply([`النموذج: ${settings.model || global.defaultModel || DEFAULT_MODEL}`, `نموذج الصور: ${IMAGE_MODEL}`, `مفتاح Gemini: ${personalKey ? "شخصي محفوظ مشفّرًا" : process.env.GEMINI_API_KEY ? "مفتاح الخدمة" : "غير مضبوط"}`, `الذاكرة: ${settings.memory === false ? "متوقفة" : "مفعّلة"}`, `البحث: ${settings.search ? "مفعّل" : "متوقف"}`, `الحد الأقصى للملف: ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB`, `الحفظ الدائم: ${redisEnabled() ? "Upstash Redis" : "غير مضمون؛ ذاكرة Vercel مؤقتة"}`, `الميزات: ${JSON.stringify(global.features || {})}`].join("\n"));
    });

    bot.command("model", async (ctx) => {
      const model = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
      const permitted = (process.env.GEMINI_ALLOWED_MODELS || "").split(",").map((v) => v.trim()).filter(Boolean);
      if (!validModel(model)) return ctx.reply(`/model <معرّف النموذج>\nالافتراضي: ${DEFAULT_MODEL}`);
      if (permitted.length && !permitted.includes(model)) return ctx.reply("هذا النموذج غير مسموح به من إعدادات المشرف.");
      const settings = await readJson(key("settings", getUserId(ctx)), {}); settings.model = model; delete settings.previousInteractionId;
      await writeJson(key("settings", getUserId(ctx)), settings); await ctx.reply(`تم تعيين النموذج إلى ${model}.`);
    });

    bot.command("system", async (ctx) => {
      const prompt = ctx.message.text.replace(/^\/system(?:@\w+)?\s*/i, "").trim();
      if (prompt.length > 1000) return ctx.reply("الحد الأقصى للتعليمات 1000 حرف.");
      const settings = await readJson(key("settings", getUserId(ctx)), {}); settings.systemPrompt = prompt;
      await writeJson(key("settings", getUserId(ctx)), settings); await ctx.reply(prompt ? "حُفظت تعليماتك." : "أزيلت تعليماتك المخصصة.");
    });

    bot.command("memory", async (ctx) => {
      const value = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!["on", "off"].includes(value)) return ctx.reply("/memory on أو /memory off");
      const settings = await readJson(key("settings", getUserId(ctx)), {}); settings.memory = value === "on";
      if (!settings.memory) delete settings.previousInteractionId;
      await writeJson(key("settings", getUserId(ctx)), settings); await ctx.reply(`الذاكرة ${settings.memory ? "مفعّلة" : "متوقفة"}.`);
    });

    bot.command("search", async (ctx) => {
      const value = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!["on", "off"].includes(value)) return ctx.reply("/search on أو /search off");
      const settings = await readJson(key("settings", getUserId(ctx)), {}); settings.search = value === "on";
      await writeJson(key("settings", getUserId(ctx)), settings); await ctx.reply(`بحث Google ${settings.search ? "مفعّل" : "متوقف"}.`);
    });

    bot.command("reset", async (ctx) => { const settings = await readJson(key("settings", getUserId(ctx)), {}); delete settings.previousInteractionId; await writeJson(key("settings", getUserId(ctx)), settings); await ctx.reply("تم مسح سياق المحادثة."); });
    bot.command("history", async (ctx) => { const logs = await readJson(key("logs", getUserId(ctx)), []); if (!logs.length) return ctx.reply("لا يوجد سجل بعد."); await ctx.reply(logs.slice(-10).map((entry, i) => `${i + 1}. ${entry.at} | ${entry.status} | ${entry.kind} | ${entry.model || ""} | ${entry.summary}`).join("\n").slice(0, 3900)); });
    bot.command("admin", async (ctx) => { if (!isAdmin(ctx)) return ctx.reply("المشرف غير مضبوط؛ استخدم BOT_ADMIN_IDS في Vercel."); await ctx.reply("/allow <id> /deny <id> /defaultmodel <id> /feature <text|image|document|audio|video|search|image_generation|tables> on|off /custom list|add|delete"); });

    bot.command("allow", async (ctx) => { if (!isAdmin(ctx)) return ctx.reply("هذا الأمر للمشرف فقط."); const id = ctx.message.text.split(/\s+/)[1]; if (!/^\d+$/.test(id || "")) return ctx.reply("/allow <Telegram user ID>"); await writeJson(key("allowed", id), true); await removeKey(key("blocked", id)); await ctx.reply(`تم السماح للمستخدم ${id}.`); });
    bot.command("deny", async (ctx) => { if (!isAdmin(ctx)) return ctx.reply("هذا الأمر للمشرف فقط."); const id = ctx.message.text.split(/\s+/)[1]; if (!/^\d+$/.test(id || "")) return ctx.reply("/deny <Telegram user ID>"); await writeJson(key("blocked", id), true); await removeKey(key("allowed", id)); await ctx.reply(`تم منع المستخدم ${id}.`); });
    bot.command("defaultmodel", async (ctx) => { if (!isAdmin(ctx)) return ctx.reply("هذا الأمر للمشرف فقط."); const model = ctx.message.text.split(/\s+/)[1]; if (!validModel(model)) return ctx.reply("/defaultmodel <model-id>"); const permitted = (process.env.GEMINI_ALLOWED_MODELS || "").split(",").map((v) => v.trim()).filter(Boolean); if (permitted.length && !permitted.includes(model)) return ctx.reply("النموذج غير مسموح به في GEMINI_ALLOWED_MODELS."); await writeJson(key("config"), { ...(await readJson(key("config"), {})), defaultModel: model }); await ctx.reply(`النموذج الافتراضي: ${model}`); });
    bot.command("feature", async (ctx) => { if (!isAdmin(ctx)) return ctx.reply("هذا الأمر للمشرف فقط."); const [, name, value] = ctx.message.text.split(/\s+/); if (!FEATURE_NAMES.has(name) || !["on", "off"].includes(value)) return ctx.reply("/feature <text|image|document|audio|video|search|image_generation|tables> on|off"); const config = await readJson(key("config"), { features: {} }); config.features = { ...config.features, [name]: value === "on" }; await writeJson(key("config"), config); await ctx.reply(`الميزة ${name}: ${value}.`); });

    bot.command("custom", async (ctx) => {
      if (!isAdmin(ctx)) return ctx.reply("هذا الأمر للمشرف فقط.");
      const rest = ctx.message.text.replace(/^\/custom(?:@\w+)?\s*/i, "").trim(); const [action, ...args] = rest.split(/\s+/);
      const config = await readJson(key("config"), { features: {} }); config.commands ||= {};
      if (action === "list") { const names = Object.keys(config.commands); return ctx.reply(names.length ? names.map((name) => `/${name}`).join("\n") : "لا توجد أوامر مخصصة."); }
      if (action === "delete") { const name = args[0]?.replace(/^\//, ""); if (!name || !config.commands[name]) return ctx.reply("/custom delete <name>"); delete config.commands[name]; await writeJson(key("config"), config); return ctx.reply(`حُذف /${name}.`); }
      const match = rest.match(/^add\s+([a-zA-Z][a-zA-Z0-9_]{1,30})\s*\|\s*([\s\S]{1,500})$/);
      if (!match) return ctx.reply("/custom add <name> | <تعليمات>");
      if (["start", "help", "apikey", "image", "table", "settings", "model", "system", "memory", "search", "reset", "history", "admin", "allow", "deny", "feature", "custom"].includes(match[1])) return ctx.reply("الاسم محجوز.");
      config.commands[match[1]] = match[2].trim(); await writeJson(key("config"), config); await ctx.reply(`أُضيف /${match[1]}.`);
    });

    bot.on(["text", "photo", "document", "audio", "voice", "video", "video_note", "animation"], async (ctx) => {
      const message = ctx.message; const text = message.text || message.caption || "حلّل الملف المرفق وأجب عنه."; const media = mediaFromMessage(message);
      const config = await readJson(key("config"), { features: {} }); let customPrompt = ""; let prompt = text;
      if (message.text?.startsWith("/")) { const match = message.text.match(/^\/([a-zA-Z][a-zA-Z0-9_]{1,30})(?:@\w+)?\s*(.*)$/s); const custom = match && config.commands?.[match[1]]; if (!custom) return; customPrompt = custom; prompt = match[2] || "نفّذ المهمة على المحتوى التالي."; }
      try { await ctx.sendChatAction(media?.type === "audio" ? "record_voice" : "typing"); await runPrompt(ctx, { prompt, media, customPrompt, logKind: media?.type || "text" }); }
      catch (error) { console.error("Interaction processing failed:", error.message); const safe = error.message?.startsWith("حجم") || error.message?.startsWith("نوع") || error.message?.startsWith("المشرف") ? error.message : "تعذرت معالجة الطلب. تحقق من إعدادات النموذج والمفتاح، ثم راجع Runtime Logs في Vercel."; await ctx.reply(safe); await record(getUserId(ctx), { kind: media?.type || "text", summary: text.slice(0, 100), status: "error" }); }
    });
  })();
  try { await initialization; } catch (error) { initialization = undefined; throw error; }
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ status: "ok", message: "Telegram webhook endpoint is online." });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.status(401).json({ error: "Unauthorized" });
  try { await initialize(); const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body; if (!update || typeof update !== "object") return res.status(400).json({ error: "Invalid Telegram update" }); await bot.handleUpdate(update); return res.status(200).json({ status: "ok" }); }
  catch (error) { console.error("Telegram webhook failed:", error.message); return res.status(500).json({ error: "Webhook processing failed" }); }
}
