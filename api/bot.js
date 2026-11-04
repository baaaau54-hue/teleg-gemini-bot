import { GoogleGenAI } from "@google/genai";
import { Telegraf } from "telegraf";

const MAX_FILE_BYTES = Math.min(
  Math.max(Number.parseInt(process.env.MAX_FILE_BYTES || "15000000", 10) || 15000000, 1024),
  18000000,
);
const HISTORY_LIMIT = 10;
const LOG_LIMIT = 20;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_TELEGRAM_TEXT = 3900;

let bot;
let ai;
const memoryStore = new Map();

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
  if (!response.ok) throw new Error(`Redis request failed with status ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error("Redis command failed");
  return payload.result;
}

function storageKey(kind, id) {
  return `teleg-gemini:${kind}:${id}`;
}

async function readJson(key, fallback) {
  if (redisEnabled()) {
    try {
      const value = await redisCommand("GET", key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.error("Persistent storage read failed:", error.message);
    }
  }
  return memoryStore.get(key) ?? fallback;
}

async function writeJson(key, value) {
  if (redisEnabled()) {
    try {
      await redisCommand("SET", key, JSON.stringify(value));
      return;
    } catch (error) {
      console.error("Persistent storage write failed:", error.message);
    }
  }
  memoryStore.set(key, value);
}

async function deleteKey(key) {
  if (redisEnabled()) {
    try {
      await redisCommand("DEL", key);
    } catch (error) {
      console.error("Persistent storage delete failed:", error.message);
    }
  }
  memoryStore.delete(key);
}

async function appendLog(userId, entry) {
  const key = storageKey("logs", userId);
  const logs = await readJson(key, []);
  logs.push({ at: new Date().toISOString(), ...entry });
  await writeJson(key, logs.slice(-LOG_LIMIT));
}

function getMessageMedia(message) {
  if (message.photo?.length) {
    return { file: message.photo.at(-1), kind: "image", mimeType: "image/jpeg", name: "photo.jpg" };
  }
  if (message.document) {
    const file = message.document;
    return {
      file,
      kind: "document",
      mimeType: file.mime_type || mimeFromName(file.file_name) || "application/octet-stream",
      name: file.file_name || "document",
    };
  }
  if (message.audio) {
    return { file: message.audio, kind: "audio", mimeType: message.audio.mime_type || "audio/mpeg", name: message.audio.file_name || "audio" };
  }
  if (message.voice) {
    return { file: message.voice, kind: "audio", mimeType: message.voice.mime_type || "audio/ogg", name: "voice.ogg" };
  }
  if (message.video) {
    return { file: message.video, kind: "video", mimeType: message.video.mime_type || "video/mp4", name: message.video.file_name || "video.mp4" };
  }
  if (message.animation) {
    return { file: message.animation, kind: "video", mimeType: message.animation.mime_type || "video/mp4", name: "animation.mp4" };
  }
  if (message.video_note) {
    return { file: message.video_note, kind: "video", mimeType: "video/mp4", name: "video-note.mp4" };
  }
  return null;
}

function mimeFromName(name = "") {
  const extension = name.toLowerCase().split(".").pop();
  return ({
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    xml: "application/xml",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  })[extension];
}

function isSupportedMedia(mimeType) {
  return mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/") ||
    ["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"].includes(mimeType);
}

async function mediaToPart(ctx, media) {
  const size = Number(media.file.file_size || 0);
  if (size > MAX_FILE_BYTES) {
    throw new Error(`الملف أكبر ��ن الحد المسموح (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }

  const fileUrl = await ctx.telegram.getFileLink(media.file.file_id);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error("تعذّر تنزيل الملف من Telegram.");

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`الملف أكبر من الحد المسموح (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }

  if (media.mimeType.startsWith("text/") || media.mimeType === "application/json" || media.mimeType === "application/xml") {
    return { type: "text", text: `\n\nمحتوى الملف (${media.name}):\n${bytes.toString("utf8").slice(0, 100000)}` };
  }
  if (!isSupportedMedia(media.mimeType)) {
    throw new Error("نوع الملف غير مدعوم. أرسل PDF أو صورة أو صوتًا أو فيديو أو ملفًا نصيًا.");
  }

  return {
    type: "media",
    part: { inlineData: { mimeType: media.mimeType, data: bytes.toString("base64") } },
    description: `${media.kind}: ${media.name}`,
  };
}

function splitTelegramText(text) {
  const chunks = [];
  let remaining = String(text || "").trim();
  while (remaining.length > MAX_TELEGRAM_TEXT) {
    let cut = remaining.lastIndexOf("\n", MAX_TELEGRAM_TEXT);
    if (cut < MAX_TELEGRAM_TEXT / 2) cut = MAX_TELEGRAM_TEXT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["لم أتمكن من إنشاء رد."];
}

async function replyLong(ctx, text) {
  for (const chunk of splitTelegramText(text)) await ctx.reply(chunk);
}

function getUserId(ctx) {
  return String(ctx.from?.id || ctx.chat.id);
}

async function initialize() {
  if (bot && ai) return;
  if (!process.env.BOT_TOKEN) throw new Error("Missing BOT_TOKEN environment variable");
  if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY environment variable");

  bot = new Telegraf(process.env.BOT_TOKEN);
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  bot.start(async (ctx) => {
    await ctx.reply("أهلًا! أرسل سؤالًا أو صورة أو PDF أو ملفًا صوتيًا/مرئيًا. استخدم /help لعرض الأوامر.");
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      "الأوامر المتاحة:\n" +
      "/start — بدء الاستخدام\n" +
      "/help — المساعدة\n" +
      "/settings — الإعدادات الحالية\n" +
      "/model <اسم> — تغيير نموذج Gemini\n" +
      "/system <تعليمات> — تخصيص أسلوب المساعد\n" +
      "/reset — مسح سياق المحادثة\n" +
      "/history — عرض سجل مختصر (آخر 5 تفاعلات)\n\n" +
      "يدعم البوت الصور وPDF والملفات النصية والصوت والفيديو ضمن حد الحجم المعروض في /settings."
    );
  });

  bot.command("settings", async (ctx) => {
    const id = getUserId(ctx);
    const settings = await readJson(storageKey("settings", id), {});
    await ctx.reply(
      `النموذج: ${settings.model || DEFAULT_MODEL}\n` +
      `تعليمات النظام: ${settings.systemPrompt || "افتراضي"}\n` +
      `حفظ دائم للسجل: ${redisEnabled() ? "مفعّل (Upstash Redis)" : "غير مفعّل؛ الذاكرة مؤقتة على Vercel"}\n` +
      `الحد الأقصى للملف: ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB`
    );
  });

  bot.command("model", async (ctx) => {
    const model = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!model || model.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(model)) {
      return ctx.reply(`الاستخدام: /model <اسم النموذج>\nالافتراضي: ${DEFAULT_MODEL}`);
    }
    const id = getUserId(ctx);
    const settings = await readJson(storageKey("settings", id), {});
    settings.model = model;
    await writeJson(storageKey("settings", id), settings);
    await ctx.reply(`تم تعيين النموذج إلى ${model}. سيظهر إن كان غير متاح عند أول طلب.`);
  });

  bot.command("system", async (ctx) => {
    const prompt = ctx.message.text.replace(/^\/system(?:@\w+)?\s*/i, "").trim();
    if (prompt.length > 500) return ctx.reply("اجعل تعليمات النظام أقصر من 500 حرف.");
    const id = getUserId(ctx);
    const settings = await readJson(storageKey("settings", id), {});
    settings.systemPrompt = prompt;
    await writeJson(storageKey("settings", id), settings);
    await ctx.reply(prompt ? "تم حفظ تعليمات المساعد الخاصة بك." : "تمت إعادة تعليمات المساعد إلى الوضع الافتراضي.");
  });

  bot.command("reset", async (ctx) => {
    const id = getUserId(ctx);
    await deleteKey(storageKey("history", id));
    await ctx.reply("تم مسح سياق المحادثة المحفوظ.");
  });

  bot.command("history", async (ctx) => {
    const id = getUserId(ctx);
    const logs = await readJson(storageKey("logs", id), []);
    if (!logs.length) return ctx.reply("لا يوجد سجل بعد.");
    const summary = logs.slice(-5).map((entry, index) => {
      const date = new Date(entry.at).toLocaleString("ar", { timeZone: "UTC" });
      return `${index + 1}. [${date} UTC] ${entry.kind}: ${entry.summary}`;
    }).join("\n");
    await ctx.reply(`آخر التفاعلات (الأوقات بتوقيت UTC):\n${summary}`);
  });

  bot.on(["text", "photo", "document", "audio", "voice", "video", "video_note", "animation"], async (ctx) => {
    const message = ctx.message;
    if (message.text?.startsWith("/")) return;

    const id = getUserId(ctx);
    const settings = await readJson(storageKey("settings", id), {});
    const history = await readJson(storageKey("history", id), []);
    const media = getMessageMedia(message);
    const userText = message.text || message.caption || "يرجى وصف هذا الملف والإجابة عن محتواه.";
    const contentParts = [{ text: userText }];
    let mediaDescription = "نص";

    try {
      await ctx.sendChatAction(media?.kind === "audio" ? "record_voice" : "typing");
      if (media) {
        const converted = await mediaToPart(ctx, media);
        if (converted.type === "text") contentParts[0].text += converted.text;
        else contentParts.push(converted.part);
        mediaDescription = converted.description;
      }

      const contents = history.flatMap((item) => [
        { role: "user", parts: [{ text: item.user }] },
        { role: "model", parts: [{ text: item.assistant }] },
      ]);
      contents.push({ role: "user", parts: contentParts });

      const result = await ai.models.generateContent({
        model: settings.model || DEFAULT_MODEL,
        contents,
        config: settings.systemPrompt ? { systemInstruction: settings.systemPrompt } : undefined,
      });
      const answer = result.text || "عذرًا، لم أستطع استخراج رد من المحتوى.";
      await replyLong(ctx, answer);

      const summary = (message.text || message.caption || mediaDescription).replace(/\s+/g, " ").slice(0, 120);
      history.push({ user: `${userText}${media ? ` [${mediaDescription}]` : ""}`.slice(0, 1000), assistant: answer.slice(0, 4000) });
      await writeJson(storageKey("history", id), history.slice(-HISTORY_LIMIT));
      await appendLog(id, { kind: mediaDescription, summary, status: "ok" });
    } catch (error) {
      console.error("Message processing failed:", error);
      const userMessage = error.message?.startsWith("ال") || error.message?.startsWith("نوع")
        ? error.message
        : "تعذّرت معالجة طلبك. تحقق من مفتاح Gemini والنموذج، ثم راجع سجلات Vercel.";
      await ctx.reply(userMessage);
      await appendLog(id, { kind: mediaDescription, summary: (userText || "media").slice(0, 120), status: "error" });
    }
  });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", message: "Telegram webhook endpoint is online." });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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
