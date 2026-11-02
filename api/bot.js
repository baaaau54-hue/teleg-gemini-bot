const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => ctx.reply('أهلاً بك! أنا مساعدك الذكي المرتبط بنماذج Gemini السحابية. تحدث معي بأي شيء.'));

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  
  try {
    // إعلام المستخدم أن البوت يكتب الآن
    await ctx.sendChatAction('typing');

    // النماذج المعتمدة والمتاحة حالياً
    const models = ["gemini-3.8-flash", "gemini-2.5-flash"];
    let replyText = null;

    for (const model of models) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userMessage }] }],
          systemInstruction: { parts: [{ text: "أنت مساعد شخصي ذكي وودود، تجيب باختصار ودقة باللغة العربية." }] }
        })
      });

      const data = await response.json();

      // إذا حدث خطأ ضغط عالي أو نموذج غير متاح، جرب النموذج التالي
      if (data.error) {
        const errMsg = data.error.message || "";
        if (errMsg.includes("high demand") || errMsg.includes("not available") || errMsg.includes("expired") || errMsg.includes("not found")) {
          continue; // جرب النموذج الذي يليه
        }
        throw new Error(errMsg);
      }

      replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (replyText) break; // نجح التوليد، اخرج من الحلقة
    }

    if (!replyText) {
      replyText = "عذراً، الخوادم مشغولة حالياً بسبب الضغط، يرجى المحاولة بعد قليل.";
    }

    await ctx.reply(replyText);
  } catch (err) {
    console.error("Gemini Error:", err);
    await ctx.reply('حدث خطأ تقني أثناء معالجة طلبك عبر Gemini.');
  }
});

// إعداد التوافق مع خوادم Vercel Serverless
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).json({ status: 'ok' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(200).send('Bot is running successfully on Vercel!');
  }
};
