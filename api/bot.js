import { GoogleGenAI } from "@google/genai";
import { Telegraf } from "telegraf";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_FILE_BYTES = Math.min(
  Math.max(Number.parseInt(process.env.MAX_FILE_BYTES || "15000000", 10) || 15000000, 1024),
  18000000,
);
const MAX_TELEGRAM_TEXT = 3900;
const LOG_LIMIT = 30;
const memoryStore = new Map();
let bot;
let ai;
let initialization;

const FEATURE_NAMES = new Set(["text", "image", "document", "audio", "video", "search"]);

function redisEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
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
    try {
      await redisCommand("DEL", storageKey);
    } catch (error) {
      console.error("Redis delete failed:", error.message);
    }
  }
  memoryStore.delete(storageKey);
}

function getUserId(ctx) {
  return String(ctx.from?.id || ctx.chat?.id || "unknown");
}

function adminIds() {
  return new Set((process.env.BOT_ADMIN_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
}

function isAdmin(ctx) {
  return adminIds().has(getUserId(ctx));
}

async function isAllowed(ctx) {
  const id = getUserId(ctx);
  if (isAdmin(ctx)) return true;
  if (await readJson(key("blocked", id), false)) return false;
  const mode = process.env.BOT_ACCESS_MODE || "open";
  if (mode !== "allowlist") return true;
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
  return ({
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    xml: "application/xml", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  })[ext];
}

function mediaFromMessage(message) {
  if (message.photo?.length) return { file: message.photo.at(-1), type: "image", mime: "image/jpeg", name: "photo.jpg" };
  if (message.document) {
    const file = message.document;
    return { file, type: "document", mime: file.mime_type || mimeFromName(file.file_name) || "application/octet-stream", name: file.file_name || "document" };
  }
  if (message.audio) return { file: message.audio, type: "audio", mime: message.audio.mime_type || "audio/mpeg", name: message.audio.file_name || "audio" };
  if (message.voice) return { file: message.voice, type: "audio", mime: message.voice.mime_type || "audio/ogg", name: "voice.ogg" };
  if (message.video) return { file: message.video, type: "video", mime: message.video.mime_type || "video/mp4", name: message.video.file_name || "video.mp4" };
  if (message.animation) return { file: message.animation, type: "video", mime: message.animation.mime_type || "video/mp4", name: message.animation.file_name || "animation.mp4" };
  if (message.video_note) return { file: message.video_note, type: "video", mime: "video/mp4", name: "video-note.mp4" };
  return null;
}

function allowedMime(mime) {
  return mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") ||
    ["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"].includes(mime);
}

async function createMediaInput(ctx, media) {
  if (Number(media.file.file_size || 0) > MAX_FILE_BYTES) {
    throw new Error(`حجم الملف يتجاوز الحد (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }
  if (!allowedMime(media.mime)) throw new Error("نوع الملف غير مدعوم. أرسل صورة أو PDF أو ملفًا نصيًا أو صوتًا أو فيديو.");
  const response = await fetch(await ctx.telegram.getFileLink(media.file.file_id));
  if (!response.ok) throw new Error("تعذّر تنزيل الملف من Telegram.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`حجم الملف يتجاوز الحد (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);

  if (media.mime.startsWith("text/") || ["application/json", "application/xml", "text/xml"].includes(media.mime)) {
    return { text: `محتوى الملف ${media.name}:\n${bytes.toString("utf8").slice(0, 100000)}` };
  }
  return { type: media.type, data: bytes.toString("base64"), mime_type: media.mime };
}

function outputText(interaction) {
  if (interaction.output_text) return interaction.output_text;
  const outputs = interaction.outputs || [];
  return outputs.filter((item) => item.type === "text").map((item) => item.text || "").join("\n").trim();
}

function chunks(text) {
  const result = [];
  let rest = String(text || "").trim();
  while (rest.length > MAX_TELEGRAM_TEXT) {
    let at = rest.lastIndexOf("\n", MAX_TELEGRAM_TEXT);
    if (at < MAX_TELEGRAM_TEXT / 2) at = MAX_TELEGRAM_TEXT;
    result.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) result.push(rest);
  return result.length ? result : ["لم أتمكن من إنشاء رد."];
}

async function replyText(ctx, text) {
  for (const part of chunks(text)) await ctx.reply(part);
}

function validModel(model) {
  return typeof model === "string" && model.length <= 100 && /^[a-zA-Z0-9._:-]+$/.test(model);
}

async function runPrompt(ctx, { prompt, media, customPrompt = "", logKind = "text" }) {
  const userId = getUserId(ctx);
  const settings = await readJson(key("settings", userId), {});
  const global = await readJson(key("config"), { features: {} });
  const model = settings.model || DEFAULT_MODEL;
  const features = global.features || {};
  const requestedFeature = media?.type || "text";
  if (features[requestedFeature] === false) throw new Error(`المشرف عطّل ميزة ${requestedFeature}.`);
  if (settings.search && features.search === false) throw new Error("البحث معطّل من قبل المشرف.");

  const input = [];
  const systemText = [settings.systemPrompt, customPrompt].filter(Boolean).join("\n\n");
  const previousId = settings.memory === false ? undefined : settings.previousInteractionId;
  const preamble = [systemText ? `التزم بهذه التعليمات الإضافية:\n${systemText}` : "", prompt].filter(Boolean).join("\n\n");
  input.push({ type: "text", text: preamble || "أجب عن الملف المرفق." });

  if (media) {
    const mediaInput = await createMediaInput(ctx, media);
    if (mediaInput.text) input[0].text += `\n\n${mediaInput.text}`;
    else input.push(mediaInput);
  }

  const request = { model, input };
  if (previousId) request.previous_interaction_id = previousId;
  if (settings.search && features.search !== false) request.tools = [{ type: "google_search" }];

  const interaction = await ai.interactions.create(request);
  const answer = outputText(interaction);
  if (!answer) throw new Error("لم يرجع Gemini نصًا. تحقق من صلاحيات النموذج أو مدخلات الملف.");
  await replyText(ctx, answer);

  if (settings.memory !== false && interaction.id) {
    settings.previousInteractionId = interaction.id;
    await writeJson(key("settings", userId), settings);
  }
  await record(userId, { kind: logKind, model, search: Boolean(settings.search), summary: prompt.slice(0, 100), status: "ok" });
}

function requireAdmin(ctx) {
  return isAdmin(ctx) ? null : "هذا الأمر للمشرف فقط.";
}

async function initialize() {
  if (bot && ai) return;
  if (initialization) return initialization;
  initialization = (async () => {
    if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN environment variable");
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY environment variable");
    bot = new Telegraf(process.env.BOT_TOKEN);
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    bot.use(async (ctx, next) => {
      if (!ctx.from) return;
      if (!(await isAllowed(ctx))) {
        if (ctx.message) await ctx.reply("ليس لديك صلاحية استخدام هذا البوت.");
        return;
      }
      return next();
    });

    bot.start((ctx) => ctx.reply("أهلًا! أرسل نصًا أو صورة أو PDF أو صوتًا أو فيديو. استخدم /help للأوامر."));
    bot.help((ctx) => ctx.reply(
      "الأوامر:\n/start /help /settings /model /system /memory /search /reset /history\n" +
      "المشرف: /admin /allow /deny /defaultmodel /feature /custom\n" +
      "الوسائط المدعومة: صور، PDF، نصوص، صوت وفيديو. استخدم /settings لمعرفة الإعدادات."
    ));

    bot.command("settings", async (ctx) => {
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      const global = await readJson(key("config"), { features: {} });
      await ctx.reply([
        `النموذج: ${settings.model || DEFAULT_MODEL}`,
        `الذاكرة: ${settings.memory === false ? "متوقفة" : "مفعّلة"}`,
        `البحث: ${settings.search ? "مفعّل" : "متوقف"}`,
        `تعليمات النظام: ${settings.systemPrompt || "افتراضي"}`,
        `الحد الأقصى للملف: ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB`,
        `الحفظ الدائم: ${redisEnabled() ? "Upstash Redis" : "غير مضمون؛ ذاكرة Vercel مؤقتة"}`,
        `ميزات الوسائط: ${JSON.stringify(global.features || {})}`,
      ].join("\n"));
    });

    bot.command("model", async (ctx) => {
      const model = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
      const permitted = (process.env.GEMINI_ALLOWED_MODELS || "").split(",").map((v) => v.trim()).filter(Boolean);
      if (!validModel(model)) return ctx.reply(`الاستخدام: /model <معرّف النموذج>\nالافتراضي: ${DEFAULT_MODEL}`);
      if (permitted.length && !permitted.includes(model)) return ctx.reply("هذا النموذج غير مسموح به من إعدادات المشرف.");
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      settings.model = model;
      delete settings.previousInteractionId;
      await writeJson(key("settings", getUserId(ctx)), settings);
      await ctx.reply(`تم تعيين النموذج إلى ${model}.`);
    });

    bot.command("system", async (ctx) => {
      const prompt = ctx.message.text.replace(/^\/system(?:@\w+)?\s*/i, "").trim();
      if (prompt.length > 1000) return ctx.reply("الحد الأقصى للتعليمات 1000 حرف.");
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      settings.systemPrompt = prompt;
      await writeJson(key("settings", getUserId(ctx)), settings);
      await ctx.reply(prompt ? "حُفظت تعليماتك." : "أزيلت تعليماتك المخصصة.");
    });

    bot.command("memory", async (ctx) => {
      const value = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!["on", "off"].includes(value)) return ctx.reply("الاستخدام: /memory on أو /memory off");
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      settings.memory = value === "on";
      if (!settings.memory) delete settings.previousInteractionId;
      await writeJson(key("settings", getUserId(ctx)), settings);
      await ctx.reply(`الذاكرة ${settings.memory ? "مفعّلة" : "متوقفة"}.`);
    });

    bot.command("search", async (ctx) => {
      const value = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
      if (!["on", "off"].includes(value)) return ctx.reply("الاستخدام: /search on أو /search off");
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      settings.search = value === "on";
      await writeJson(key("settings", getUserId(ctx)), settings);
      await ctx.reply(`بحث Google ${settings.search ? "مفعّل" : "متوقف"}.`);
    });

    bot.command("reset", async (ctx) => {
      const settings = await readJson(key("settings", getUserId(ctx)), {});
      delete settings.previousInteractionId;
      await writeJson(key("settings", getUserId(ctx)), settings);
      await ctx.reply("تم مسح سياق المحادثة.");
    });

    bot.command("history", async (ctx) => {
      const logs = await readJson(key("logs", getUserId(ctx)), []);
      if (!logs.length) return ctx.reply("لا يوجد سجل بعد.");
      await ctx.reply(logs.slice(-10).map((entry, i) => `${i + 1}. ${entry.at} | ${entry.status} | ${entry.kind} | ${entry.model} | ${entry.summary}`).join("\n").slice(0, 3900));
    });

    bot.command("admin", async (ctx) => {
      if (!isAdmin(ctx)) return ctx.reply("أنت لست مشرفًا. عيّن BOT_ADMIN_IDS في Vercel.");
      await ctx.reply("أوامر المشرف: /allow <id>, /deny <id>, /defaultmodel <id>, /feature <name> on|off, /custom list|add|delete.\nالميزات: text image document audio video search");
    });

    bot.command("allow", async (ctx) => {
      if (requireAdmin(ctx)) return ctx.reply(requireAdmin(ctx));
      const id = ctx.message.text.split(/\s+/)[1];
      if (!/^\d+$/.test(id || "")) return ctx.reply("الاستخدام: /allow <Telegram user ID>");
      await writeJson(key("allowed", id), true);
      await removeKey(key("blocked", id));
      await ctx.reply(`تم السماح للمستخدم ${id}.`);
    });

    bot.command("deny", async (ctx) => {
      if (requireAdmin(ctx)) return ctx.reply(requireAdmin(ctx));
      const id = ctx.message.text.split(/\s+/)[1];
      if (!/^\d+$/.test(id || "")) return ctx.reply("الاستخدام: /deny <Telegram user ID>");
      await writeJson(key("blocked", id), true);
      await removeKey(key("allowed", id));
      await ctx.reply(`تم منع المستخدم ${id}.`);
    });

    bot.command("defaultmodel", async (ctx) => {
      if (requireAdmin(ctx)) return ctx.reply(requireAdmin(ctx));
      const model = ctx.message.text.split(/\s+/)[1];
      if (!validModel(model)) return ctx.reply("الاستخدام: /defaultmodel <model-id>");
      const permitted = (process.env.GEMINI_ALLOWED_MODELS || "").split(",").map((v) => v.trim()).filter(Boolean);
      if (permitted.length && !permitted.includes(model)) return ctx.reply("النموذج ليس في GEMINI_ALLOWED_MODELS.");
      await writeJson(key("config"), { ...(await readJson(key("config"), {})), defaultModel: model });
      await ctx.reply(`تم تعيين النموذج الافتراضي إلى ${model}.`);
    });

    bot.command("feature", async (ctx) => {
      if (requireAdmin(ctx)) return ctx.reply(requireAdmin(ctx));
      const [, name, value] = ctx.message.text.split(/\s+/);
      if (!FEATURE_NAMES.has(name) || !["on", "off"].includes(value)) return ctx.reply("الاستخدام: /feature <text|image|document|audio|video|search> on|off");
      const config = await readJson(key("config"), { features: {} });
      config.features = { ...config.features, [name]: value === "on" };
      await writeJson(key("config"), config);
      await ctx.reply(`الميزة ${name}: ${value}.`);
    });

    bot.command("custom", async (ctx) => {
      if (requireAdmin(ctx)) return ctx.reply(requireAdmin(ctx));
      const rest = ctx.message.text.replace(/^\/custom(?:@\w+)?\s*/i, "").trim();
      const [action, ...args] = rest.split(/\s+/);
      const config = await readJson(key("config"), { features: {} });
      config.commands ||= {};
      if (action === "list") {
        const names = Object.keys(config.commands);
        return ctx.reply(names.length ? names.map((name) => `/${name}`).join("\n") : "لا توجد أوامر مخصصة.");
      }
      if (action === "delete") {
        const name = args[0]?.replace(/^\//, "");
        if (!name || !config.commands[name]) return ctx.reply("الاستخدام: /custom delete <name>");
        delete config.commands[name];
        await writeJson(key("config"), config);
        return ctx.reply(`حُذف الأمر /${name}.`);
      }
      const addMatch = rest.match(/^add\s+([a-zA-Z][a-zA-Z0-9_]{1,30})\s*\|\s*([\s\S]{1,500})$/);
      if (!addMatch) return ctx.reply("الاستخدام: /custom add <name> | <تعليمات الأمر>\nمثال: /custom add translate | ترجم النص إلى العربية");
      if (["start", "help", "settings", "model", "system", "memory", "search", "reset", "history", "admin", "allow", "deny", "feature", "custom"].includes(addMatch[1])) return ctx.reply("هذا الاسم محجوز.");
      config.commands[addMatch[1]] = addMatch[2].trim();
      await writeJson(key("config"), config);
      await ctx.reply(`أُضيف الأمر /${addMatch[1]}.`);
    });

    bot.on(["text", "photo", "document", "audio", "voice", "video", "video_note", "animation"], async (ctx) => {
      const message = ctx.message;
      const text = message.text || message.caption || "حلّل الملف المرفق وأجب عنه.";
      const media = mediaFromMessage(message);
      const config = await readJson(key("config"), { features: {} });
      let customPrompt = "";
      let prompt = text;
      if (message.text?.startsWith("/")) {
        const match = message.text.match(/^\/([a-zA-Z][a-zA-Z0-9_]{1,30})(?:@\w+)?\s*(.*)$/s);
        const custom = match && config.commands?.[match[1]];
        if (!custom) return;
        customPrompt = custom;
        prompt = match[2] || "نفّذ المهمة على المحتوى التالي.";
      }
      try {
        await ctx.sendChatAction(media?.type === "audio" ? "record_voice" : "typing");
        await runPrompt(ctx, { prompt, media, customPrompt, logKind: media?.type || "text" });
      } catch (error) {
        console.error("Interaction processing failed:", error);
        const safeMessage = error.message?.startsWith("حجم") || error.message?.startsWith("نوع") || error.message?.startsWith("المشرف")
          ? error.message
          : "تعذرت معالجة الطلب. تحقق من النموذج ومفتاح Gemini، ثم راجع Runtime Logs في Vercel.";
        await ctx.reply(safeMessage);
        await record(getUserId(ctx), { kind: media?.type || "text", summary: text.slice(0, 100), status: "error" });
      }
    });
  })();
  try {
    await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ status: "ok", message: "Telegram webhook endpoint is online." });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.status(401).json({ error: "Unauthorized" });
  try {
    await initialize();
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!update || typeof update !== "object") return res.status(400).json({ error: "Invalid Telegram update" });
    await bot.handleUpdate(update);
    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
