# Telegram Gemini Bot

Telegram webhook bot hosted as a Vercel serverless function. Uses Gemini Interactions and supports text, media, image generation, downloadable Excel tables, per-user Gemini API keys, conversation memory, Google Search, admin permissions, and custom prompt commands.

## Required Vercel environment variables

Set in **Production**, then redeploy:

- `BOT_TOKEN` — Telegram token; keep secret. Revoke any previously exposed token.
- `GEMINI_API_KEY` — service/default Gemini API key. Optional only if every user supplies their own key.
- `BOT_ADMIN_IDS` — comma-separated numeric Telegram IDs for admins.
- `USER_API_KEYS_ENCRYPTION_KEY` — required to accept personal API keys. Generate a strong random secret locally; never commit/share it. Changing it later makes existing encrypted user keys unreadable.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — strongly recommended and required for reliable persistence of personal keys/settings in serverless deployments.

Optional:

- `GEMINI_MODEL` — default chat model, defaults to `gemini-3.8-flash`. Model availability is determined by the selected API key.
- `GEMINI_IMAGE_MODEL` — image generation model, defaults to `gemini-3-pro-image-preview`; availability must be checked for each API key.
- `GEMINI_ALLOWED_MODELS` — comma-separated model IDs users/admins can select.
- `MAX_FILE_BYTES` — media upload limit; defaults to 15 MB, capped at 18 MB.
- `BOT_ACCESS_MODE` — `open` (default) or `allowlist`.
- `BOT_ALLOWED_USER_IDS` — comma-separated initial allowed IDs when using allowlist mode.
- `TELEGRAM_WEBHOOK_SECRET` — optional Telegram webhook secret; set the same value with Telegram `setWebhook`.

## User commands

- `/start`, `/help`, `/settings`
- `/model <model-id>` — select chat model
- `/system <instructions>` — customize assistant behavior; empty `/system` clears it
- `/memory on|off`, `/search on|off`, `/reset`, `/history`
- `/image <description>` — generate and send an image (requires an image-capable model/key)
- `/table <request>` — create a table preview in chat and attach a real `.xlsx` spreadsheet
- `/apikey set <key>` — set a personal Gemini API key **in a private chat only**
- `/apikey status`, `/apikey delete`

Personal keys are encrypted at rest using AES-256-GCM with `USER_API_KEYS_ENCRYPTION_KEY`. The key-setting command attempts to delete the Telegram message containing the key and never writes the key to app logs or shows it in `/settings`. Telegram may retain messages or delivery metadata; this is not a zero-disclosure channel. Users should create/revoke keys in Google AI Studio and must not send keys in groups. Each user's own Gemini account usage/billing applies when their key is selected. If no personal key exists, requests use the service key if configured. Personal keys do not bypass bot access controls or feature restrictions.

## Admin commands

Admins are numeric IDs configured in `BOT_ADMIN_IDS`:

- `/admin`
- `/allow <telegram-id>`, `/deny <telegram-id>`
- `/defaultmodel <model-id>`
- `/feature <text|image|document|audio|video|search|image_generation|tables> on|off`
- `/custom add <name> | <instructions>`, `/custom delete <name>`, `/custom list`

Custom commands are prompt templates, not executable code. Allowlisting is configured using `BOT_ACCESS_MODE=allowlist` and `BOT_ALLOWED_USER_IDS` or `/allow`.

## Media, tables, memory, and storage

Images, PDFs, supported text files, audio, and video are passed to Gemini as multimodal inputs subject to Google model support and size limits. `/table` asks Gemini for structured rows, sends a plain-text preview (Telegram messages do not provide native spreadsheet grid cells), and attaches a formatted, editable Excel `.xlsx` workbook. Media bytes are not retained in logs.

Conversation continuation uses Interactions API IDs. Activity logs contain short summaries, model, type, status, and timestamp. Upstash Redis persists settings, encrypted personal keys, interaction IDs, access lists, custom prompts, and logs. Without Redis, state is only ephemeral in serverless memory; do not rely on that for keys or settings. Configure private Redis and retention controls. The bot does not expose a user's personal API key to admins or other users.

## Webhook and deployment

Deploy the intended branch/commit in Vercel. Production code must include these changes. Set the webhook URL to `https://<your-domain>/api/bot`. If using `TELEGRAM_WEBHOOK_SECRET`, pass the identical value as Telegram's `secret_token` when calling `setWebhook`. Keep bot/API tokens and encryption secrets out of chat and source control.

## Troubleshooting

A successful build or GET health check does not prove Gemini model access. If model/image generation fails, verify that the exact model is enabled for the key used by that user and inspect Vercel Runtime Logs. Image generation model availability and billing may differ by account.
