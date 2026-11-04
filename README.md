# Telegram Gemini Bot

A Telegram webhook bot deployed as a Vercel serverless function. It supports text, images, PDFs, supported audio/video files, per-user model/system-prompt settings, conversation context, and a short activity log.

## Required Vercel environment variables

Set these for **Production**, then redeploy:

- `BOT_TOKEN` — Telegram token from BotFather. Keep it secret.
- `GEMINI_API_KEY` — Google AI Studio API key. Keep it secret.

Optional:

- `GEMINI_MODEL` — default model (defaults to `gemini-2.5-flash`). Model availability depends on your Gemini API account.
- `MAX_FILE_BYTES` — maximum Telegram media size in bytes (defaults to 15,000,000; capped at 18,000,000).
- `TELEGRAM_WEBHOOK_SECRET` — optional webhook secret. If set, configure the same value as Telegram's `secret_token` when calling `setWebhook`.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — optional Upstash Redis REST credentials for durable settings, conversation context, and logs. Without these, data is held only in the serverless instance's memory and may disappear between invocations.

## Webhook

After deployment, set Telegram's webhook URL to:

`https://<your-production-domain>/api/bot`

For example, from PowerShell (do not paste the bot token into chat):

```powershell
$token = Read-Host "BOT_TOKEN"
$webhook = "https://<your-production-domain>/api/bot"
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -Body @{ url = $webhook }
