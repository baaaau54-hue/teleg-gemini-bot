import { GoogleGenAI } from "@google/genai";
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN);
// تهيئة العميل باستخدام المفتاح المخزن في متغيرات البيئة بـ Vercel
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

bot.start((ctx) => ctx.reply('أهلاً بك! أنا مساعدك الذكي المحدث وفقاً لأحدث معايير Google GenAI SDK.'));

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  
  try {
    // إعلام المستخدم أن البوت يكتب الآن
    await ctx.sendChatAction('typing');

    // استخدام Interactions API مع نموذج gemini-3.8-flash كما جاء في التوثيق الأخير
    const interaction = await ai.interactions.create({
      model: "gemini-3.8-flash",
      input: userMessage,
    });

    // استخراج الرد بالهيكل الجديد
    const replyText = interaction.output || "عذراً، لم أستطع استخراج الرد.";
    await ctx.reply(replyText);

  } catch (err) {
    console.error("Gemini SDK Error:", err);
    await ctx.reply('حدث خطأ تقني أثناء معالجة طلبك عبر Interactions API.');
  }
});

// إعداد السيرفر السحابي لـ Vercel Serverless
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).json({ status: 'ok' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(200).send('Bot with GoogleGenAI SDK is running successfully!');
  }
};
