const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ---- Config & startup validation ----------------------------------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const APP_SECRET = process.env.APP_SECRET; // shared secret the mobile app must send
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // optional web origin (e.g. https://expiryos.app)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CHAT_MODEL = 'openrouter/auto';
// /scan-text needs a model that reliably returns just the requested JSON
// within a small token budget. 'openrouter/auto' is unpredictable here — it
// can route to a reasoning model that burns most of the token budget on
// hidden chain-of-thought before writing the actual answer, truncating the
// JSON. Pinned to a plain instruct model with no reasoning tier instead.
const SCAN_TEXT_MODEL = 'openai/gpt-5.4-mini';
// Qwen's vision-language line is specifically strong on documents, receipts,
// and invoices (OCRBench/DocVQA), unlike a general-purpose vision model.
// Verified against OpenRouter's live /api/v1/models list before using —
// older/newer Qwen VL model slugs come and go, so don't hardcode one without
// checking it actually exists first.
const VISION_MODEL = 'qwen/qwen3-vl-8b-instruct';

if (!OPENROUTER_KEY) {
  console.error('FATAL: OPENROUTER_KEY is not set. Refusing to start.');
  process.exit(1);
}
if (!APP_SECRET) {
  console.warn('WARNING: APP_SECRET is not set — the API is unauthenticated and open to abuse. Set APP_SECRET in your environment.');
}

// ---- Hardening middleware ------------------------------------------------
app.disable('x-powered-by');
app.use(helmet());

// Mobile (React Native) requests send no Origin header, so allow those.
// Browsers only get through if their Origin matches ALLOWED_ORIGIN.
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);            // native app / curl
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return callback(null, true);
    return callback(null, false);                        // block other browser origins
  },
  methods: ['POST', 'GET'],
}));

app.use(express.json({ limit: '8mb' }));

// Rate limit: cap requests per IP to contain cost/abuse.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,                  // 60 requests / IP / window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use(['/chat', '/scan'], limiter);

// Shared-secret auth for the AI endpoints.
function requireAppKey(req, res, next) {
  if (!APP_SECRET) return next(); // not configured yet — allow, but warned at boot
  const provided = req.get('x-app-key');
  if (!provided || provided !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---- Input validation helpers -------------------------------------------
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 8000;
const MAX_BASE64_CHARS = 8 * 1024 * 1024; // ~6MB image
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

function isValidMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  return messages.every(m =>
    m &&
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    m.content.length <= MAX_CONTENT_CHARS
  );
}

// ---- Routes --------------------------------------------------------------
app.post('/chat', requireAppKey, async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body || {};
    if (!isValidMessages(messages)) {
      return res.status(400).json({ error: 'Invalid messages payload.' });
    }
    if (systemPrompt != null && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_CONTENT_CHARS)) {
      return res.status(400).json({ error: 'Invalid systemPrompt.' });
    }

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://expiryos.app',
        'X-Title': 'ExpiryOS',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          ...messages,
        ],
        max_tokens: 512,
        // AI governance: only route to providers with zero data retention.
        // See MONETIZATION.md / AI_PRIVACY.md for the full data-handling policy.
        provider: { data_collection: 'deny' },
      }),
    });
    const data = await response.json();
    res.status(response.ok ? 200 : 502).json(data);
  } catch (e) {
    console.error('POST /chat error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/scan', requireAppKey, async (req, res) => {
  try {
    const { base64Image, mimeType, prompt } = req.body || {};
    if (typeof base64Image !== 'string' || base64Image.length === 0 || base64Image.length > MAX_BASE64_CHARS) {
      return res.status(400).json({ error: 'Invalid or oversized image.' });
    }
    if (typeof mimeType !== 'string' || !ALLOWED_MIME.has(mimeType)) {
      return res.status(400).json({ error: 'Unsupported image type.' });
    }
    if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({ error: 'Invalid prompt.' });
    }

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://expiryos.app',
        'X-Title': 'ExpiryOS',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
        // Same 16-field schema as /scan-text — 512 was too tight.
        max_tokens: 1024,
        // AI governance: only route to providers with zero data retention.
        // See MONETIZATION.md / AI_PRIVACY.md for the full data-handling policy.
        provider: { data_collection: 'deny' },
      }),
    });
    const data = await response.json();
    res.status(response.ok ? 200 : 502).json(data);
  } catch (e) {
    console.error('POST /scan error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Text-only counterpart to /scan — used when the app already extracted text
// from the document on-device (see lib/ocr.js client-side), so no photo is
// ever uploaded for this path. Uses the cheap text model instead of a vision
// model, since there's no image involved.
app.post('/scan-text', requireAppKey, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({ error: 'Invalid prompt.' });
    }

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://expiryos.app',
        'X-Title': 'ExpiryOS',
      },
      body: JSON.stringify({
        model: SCAN_TEXT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // Larger budget than /chat since the scan JSON schema has 16 fields
        // plus a summary sentence — 512 was too tight even without reasoning
        // tokens involved.
        max_tokens: 1024,
        // AI governance: only route to providers with zero data retention.
        // See MONETIZATION.md / AI_PRIVACY.md for the full data-handling policy.
        provider: { data_collection: 'deny' },
      }),
    });
    const data = await response.json();
    res.status(response.ok ? 200 : 502).json(data);
  } catch (e) {
    console.error('POST /scan-text error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'ExpiryOS backend' });
});

// Public privacy policy page — required by Apple/Google app store listings.
// Not a legal opinion; have this reviewed by a lawyer before relying on it,
// especially given the sensitive document categories Expiry handles
// (immigration, medical, legal, tax).
app.get('/privacy', (req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML);
});

const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Expiry</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 48px 24px 80px; line-height: 1.6; color: #1C1430; background: #FBF7F2; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .updated { color: #6a5f7a; font-size: 14px; margin-bottom: 32px; }
  h2 { font-size: 19px; margin-top: 36px; color: #FF3D6E; }
  p, li { font-size: 15.5px; }
  a { color: #FF3D6E; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <div class="updated">Expiry, by AIyla &middot; Last updated July 13, 2026</div>

  <p>Expiry is built local-first: your reminders, documents, and vault data are stored on your device, not on our servers. This page explains exactly what data exists, where it goes, and why.</p>

  <h2>Data stored only on your device</h2>
  <ul>
    <li>Reminders, categories, due dates, amounts, notes, and vault records</li>
    <li>Attached document photos</li>
    <li>Your app lock PIN and Face ID/Touch ID preference (biometric data itself is handled only by your device's operating system — we never see it)</li>
    <li>Encrypted backup exports, created and decrypted only with a passphrase you choose; we never see this passphrase or your backup contents</li>
  </ul>
  <p>We do not operate a server that stores this data. Uninstalling the app or restoring your device erases it, unless you've saved an encrypted backup file yourself.</p>

  <h2>AI features (Expiry Plus only)</h2>
  <p>The AI assistant chat and document scan are optional, paid features. When used:</p>
  <ul>
    <li><strong>Chat</strong> sends your message and a summary of your reminders (name, category, due date, status; also amounts, issuers, and notes if Private Mode is off) to our backend, which forwards it to an AI model via OpenRouter.</li>
    <li><strong>Document scan</strong> sends a photo of the scanned document so its details can be read.</li>
    <li>Every request is configured with OpenRouter's zero-data-retention setting, routed only to providers that do not store or train on the content.</li>
    <li>Our backend does not log or store chat messages or document photos — it forwards requests and returns responses.</li>
  </ul>
  <p>These features are off unless you explicitly use them, and you can revoke consent anytime in Settings.</p>

  <h2>Subscriptions</h2>
  <p>Expiry Plus subscriptions are processed by Apple (App Store) or Google (Play Store) and managed via RevenueCat, our subscription infrastructure provider. RevenueCat receives your purchase receipt and a device/app identifier to verify entitlement — it does not receive your reminders, documents, or any content you store in the app.</p>

  <h2>Advertising (Free tier)</h2>
  <p>Free-tier users see banner ads served by Google AdMob. AdMob may collect advertising identifiers and device information to serve and measure ads, per <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google's own privacy policy</a>. Expiry Plus subscribers never see ads and are not subject to AdMob's data collection.</p>

  <h2>Permissions we ask for</h2>
  <ul>
    <li><strong>Camera / Photo Library</strong> &mdash; only used when you choose to scan or attach a document photo.</li>
    <li><strong>Notifications</strong> &mdash; used to remind you before a reminder is due.</li>
    <li><strong>Face ID / Touch ID</strong> &mdash; only to unlock the app locally if you enable App Lock; biometric data itself never leaves your device or reaches us.</li>
  </ul>

  <h2>Children's privacy</h2>
  <p>Expiry is not directed at children under 13, and we do not knowingly collect data from them.</p>

  <h2>Your rights</h2>
  <p>Since nearly all your data lives on your device, you control it directly &mdash; edit or delete anything in the app, or delete the app to erase it entirely. For AI-related requests processed via our backend, no server-side copy is retained, so there is nothing additional to request or delete.</p>

  <h2>Changes to this policy</h2>
  <p>We'll update this page if our data practices change, and update the "Last updated" date above.</p>

  <h2>Contact</h2>
  <p>Questions about this policy: <a href="mailto:aiylainnovation@gmail.com">aiylainnovation@gmail.com</a></p>
</body>
</html>`;

// Catch-all error handler. Without this, errors thrown by middleware before
// a route runs (e.g. express.json() rejecting an oversized or malformed
// body) fall through to Express's default handler, which sends a plain-text
// or HTML error page — the mobile app always expects JSON and crashes with a
// confusing "JSON Parse error" when it gets one of those instead. This
// guarantees every response, success or failure, is valid JSON.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Image too large. Try a smaller or more compressed photo.' });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed request.' });
  }
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ExpiryOS backend running on port ${PORT}`));
