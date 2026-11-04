import { GoogleGenAI } from "@google/genai";
import { Telegraf } from "telegraf";

let bot;
let ai;

function initialize() {
  if (bot && ai) return;

  const botToken = process.env.BOT_TOKEN;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!botToken) throw new Error("Missing BOT_TOKEN environment variable");
  if (!geminiApiKey) throw new Error("Missing GEMINI_API_KEY environment variable");

  bot = new Telegraf(botToken);
  ai = new GoogleGenAI({ apiKey: geminiApiKey });

  bot.start((ctx) =>
    ctx.reply("أهلاً بك! أنا مساعدك الذكي. أرسل لي سؤالك وسأحاول الإجابة عنه.")
  );

  bot.on("text", async (ctx) => {
    try {
      await ctx.sendChatAction("typing");
      const interaction = await ai.interactions.create({
        model: "gemini-3.8-flash",
        input: ctx.message.text,
      });
      const replyText = interaction.output || "عذراً، لم أستطع استخراج الرد.";
      await ctx.reply(replyText);
    } catch (error) {
      console.error("Gemini request failed:", error);
      await ctx.reply("حدث خطأ أثناء معالجة طلبك. يرجى المحاولة لاحقاً.");
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

  try {
    initialize();
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!update || typeof update !== "object") {
      return res.status(400).json({ error: "Invalid Telegram update" });
    }
    await bot.handleUpdate(update);
    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
