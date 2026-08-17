import type { VercelRequest, VercelResponse } from '@vercel/node';
import { classifyRemotePdf } from './remote-pdf.js';
import { listRecords as listParadoxRecords, savePending as saveParadoxPending } from './store.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME?.replace(/^@/, '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org/bot').replace(/\/$/, '');
const PARADOX_ENABLED = Boolean(process.env.PARADOX_API_KEY && process.env.PARADOX_PASSPHRASE);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_LOG_PATH = process.env.GITHUB_LOG_PATH || 'data/pdf-dashboard.md';
const TELEGRAM_API_URL = `${TELEGRAM_API_BASE}${BOT_TOKEN || ''}`;
const PDFBOT_WORKER_URL = process.env.PDFBOT_WORKER_URL?.replace(/\/$/, '');
const PDFBOT_WORKER_SECRET = process.env.PDFBOT_WORKER_SECRET;
const PDFBOT_CALLBACK_URL = process.env.PDFBOT_CALLBACK_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/worker-callback` : undefined);
const PDFBOT_CALLBACK_SECRET = process.env.PDFBOT_CALLBACK_SECRET || WEBHOOK_SECRET;

 type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
 type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
 type TelegramChat = { id: number; username?: string; title?: string };
 type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  document?: TelegramDocument;
  text?: string;
  date: number;
};
 type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from: TelegramUser;
  message?: TelegramMessage;
};
 type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

 type Classification = 'Scanned' | 'Selectable' | 'Needs inspection';
 type RecordEntry = {
  id: string;
  title: string;
  sender: string;
  senderId: number;
  type: Classification;
  channelUrl: string;
  receivedAt: string;
  strategy?: string;
  bytesRead?: number;
  pagesSampled?: number;
};
 type TelegramResponseMessage = { message_id: number };

const categoryKeyboard = {
  inline_keyboard: [[
    { text: 'Selectable PDFs', callback_data: 'list:Selectable' },
    { text: 'Scanned PDFs', callback_data: 'list:Scanned' },
  ]],
};

async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API_URL}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || 'request failed'}`);
  return result.result as T;
}

function senderName(user?: TelegramUser): string {
  if (!user) return 'Unknown sender';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return user.username ? `${full || user.username} (@${user.username})` : (full || 'Unknown sender');
}

function channelMessageUrl(messageId: number): string {
  if (CHANNEL_USERNAME) return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
  const normalized = (CHANNEL_ID || '').replace(/^-100/, '');
  return `https://t.me/c/${normalized}/${messageId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character] || character));
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/[|\n\r]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function markdown(entries: RecordEntry[]): string {
  const header = '# PDF Dashboard\n\n| Title | Sender | Type | Telegram source | Received |\n|---|---|---|---|---|\n';
  const rows = entries.map((entry) => `| ${escapeMarkdownCell(entry.title)} | ${escapeMarkdownCell(entry.sender)} | **${entry.type}** | [Open PDF](${entry.channelUrl}) | ${escapeMarkdownCell(entry.receivedAt)} |`).join('\n');
  return `${header}${rows}\n`;
}

async function readGithubLog(): Promise<{ entries: RecordEntry[]; sha?: string }> {
  if (PARADOX_ENABLED) {
    const records = await listParadoxRecords();
    return {
      entries: records.map((record) => ({
        id: record.id,
        title: record.title,
        sender: record.sender,
        senderId: record.sender_id,
        type: record.classification,
        channelUrl: record.source_url,
        receivedAt: record.received_at,
        strategy: record.strategy,
        bytesRead: record.bytes_read,
        pagesSampled: record.pages_sampled,
      })),
    };
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) return { entries: [] };
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_LOG_PATH}`, {
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'telegram-pdf-classifier',
    },
  });
  if (response.status === 404) return { entries: [] };
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);

  const file = await response.json() as { content: string; sha: string };
  const content = Buffer.from(file.content, 'base64').toString('utf8');
  const entries: RecordEntry[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\| (.*?) \| (.*?) \| \*\*(Scanned|Selectable|Needs inspection)\*\* \| \[Open PDF\]\((.*?)\) \| (.*?) \|$/);
    if (!match) continue;
    entries.push({
      id: `${entries.length}`,
      title: match[1],
      sender: match[2],
      senderId: 0,
      type: match[3] as Classification,
      channelUrl: match[4],
      receivedAt: match[5],
    });
  }
  return { entries, sha: file.sha };
}

async function writeGithubLog(entries: RecordEntry[], sha?: string): Promise<void> {
  if (PARADOX_ENABLED || !GITHUB_TOKEN || !GITHUB_REPO) return;
  const body: Record<string, unknown> = {
    message: `Record PDF: ${entries[entries.length - 1]?.title || 'update'}`,
    content: Buffer.from(markdown(entries), 'utf8').toString('base64'),
    branch: process.env.GITHUB_BRANCH || 'main',
  };
  if (sha) body.sha = sha;

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_LOG_PATH}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'telegram-pdf-classifier',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub write failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

async function sendCategoryList(chatId: number, type: 'Scanned' | 'Selectable'): Promise<void> {
  const { entries } = await readGithubLog();
  const filtered = entries.filter((entry) => entry.type === type).reverse();
  if (!filtered.length) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `No ${type.toLowerCase()} PDFs have been recorded yet.`,
      reply_markup: categoryKeyboard,
    });
    return;
  }

  const header = `<b>${type} PDFs</b>\n\n`;
  const lines = filtered.map((entry, index) => `${index + 1}. <a href="${escapeHtml(entry.channelUrl)}">${escapeHtml(truncate(entry.title, 180))}</a> — ${escapeHtml(truncate(entry.sender, 120))}`);
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3800) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: categoryKeyboard,
      });
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: categoryKeyboard,
    });
  }
}

function classificationResultText(title: string, result: { type: Classification; strategy: string; pagesSampled: number }): string {
  const safeTitle = escapeHtml(truncate(title, 180));
  if (result.type === 'Needs inspection') {
    return `<b>${safeTitle}</b>\n\nI could not safely classify this PDF. It has been marked <b>Needs inspection</b>.`;
  }
  const explanation = result.type === 'Selectable'
    ? 'Selectable text was found in the sampled pages.'
    : 'No meaningful selectable text was found in the sampled pages, so it is classified as scanned.';
  return `<b>${safeTitle}</b>\n\nClassification: <b>${result.type}</b>\n${explanation}\nInspection: ${escapeHtml(result.strategy)} (${result.pagesSampled} page(s) sampled).`;
}

async function updateUserResult(chatId: number, progressMessageId: number, title: string, result: { type: Classification; strategy: string; pagesSampled: number }): Promise<void> {
  const text = classificationResultText(title, result);
  try {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: progressMessageId,
      text,
      parse_mode: 'HTML',
      reply_markup: categoryKeyboard,
    });
  } catch (error) {
    console.error('User result edit failed:', error);
    await telegram('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: categoryKeyboard,
    });
  }
}

type WorkerContext = {
  chatId: number;
  progressMessageId: number;
  sourceMessageId: number;
  senderId: number;
  title: string;
  sender: string;
  recordId: string;
};

type ClassificationResult = { type: Classification; strategy: string; bytesRead: number; pagesSampled: number; reason?: string };

async function finishDocument(context: WorkerContext, result: ClassificationResult): Promise<void> {
  await updateUserResult(context.chatId, context.progressMessageId, context.title, result);
  let copied: TelegramResponseMessage;
  try {
    copied = await telegram<TelegramResponseMessage>('copyMessage', { chat_id: CHANNEL_ID, from_chat_id: context.chatId, message_id: context.sourceMessageId });
  } catch (error) {
    console.error('Channel forwarding failed:', error);
    await telegram('sendMessage', { chat_id: context.chatId, text: 'The PDF was classified, but I could not forward it to the configured channel. Please verify the channel ID and bot administrator permissions.' });
    return;
  }
  const sourceUrl = channelMessageUrl(copied.message_id);
  const caption = [
    `<b>Title:</b> ${escapeHtml(truncate(context.title, 400))}`,
    `<b>Type:</b> ${escapeHtml(result.type)}`,
    `<b>Sender:</b> ${escapeHtml(truncate(context.sender, 250))}`,
    `<b>Strategy:</b> ${escapeHtml(result.strategy)}`,
    `<a href="${escapeHtml(sourceUrl)}">Open PDF</a>`,
  ].join('\n');
  try {
    await telegram('editMessageCaption', { chat_id: CHANNEL_ID, message_id: copied.message_id, caption, parse_mode: 'HTML', reply_markup: categoryKeyboard });
  } catch (error) {
    console.error('Channel caption or button update failed:', error);
  }
  const entry: RecordEntry = {
    id: context.recordId, title: context.title, sender: context.sender, senderId: context.senderId,
    type: result.type, channelUrl: sourceUrl, receivedAt: new Date().toISOString(),
    strategy: result.strategy, bytesRead: result.bytesRead, pagesSampled: result.pagesSampled,
  };
  try {
    if (PARADOX_ENABLED) {
      await saveParadoxPending({ id: context.recordId, title: context.title, sender: context.sender, sender_id: context.senderId, classification: result.type, source_url: sourceUrl, received_at: entry.receivedAt, strategy: result.strategy, bytes_read: result.bytesRead, pages_sampled: result.pagesSampled, metadata_message_id: copied.message_id });
    } else {
      const log = await readGithubLog();
      await writeGithubLog([...log.entries, entry], log.sha);
    }
  } catch (error) {
    console.error('PDF record persistence failed:', error);
  }
}

async function processDocument(message: TelegramMessage): Promise<void> {
  const document = message.document!;
  const title = document.file_name || 'Untitled PDF';
  const context: WorkerContext = { chatId: message.chat.id, progressMessageId: 0, sourceMessageId: message.message_id, senderId: message.from?.id || 0, title, sender: senderName(message.from), recordId: `${Date.now()}-${message.message_id}` };
  const progress = await telegram<TelegramResponseMessage>('sendMessage', { chat_id: message.chat.id, text: `<b>${escapeHtml(truncate(title, 180))}</b>\n\nPDF received. I am checking whether it is selectable or scanned…`, parse_mode: 'HTML', reply_markup: categoryKeyboard });
  context.progressMessageId = progress.message_id;

  if (PDFBOT_WORKER_URL && PDFBOT_CALLBACK_URL) {
    try {
      const response = await fetch(`${PDFBOT_WORKER_URL}/pdfbot/classify`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(PDFBOT_WORKER_SECRET ? { 'x-pdfbot-worker-secret': PDFBOT_WORKER_SECRET } : {}) },
        body: JSON.stringify({ bot_token: BOT_TOKEN, file_id: document.file_id, job_id: context.recordId, callback_url: PDFBOT_CALLBACK_URL, callback_secret: PDFBOT_CALLBACK_SECRET, context }),
      });
      if (!response.ok) throw new Error(`Worker dispatch failed: ${response.status}`);
      await telegram('editMessageText', { chat_id: message.chat.id, message_id: progress.message_id, text: `<b>${escapeHtml(truncate(title, 180))}</b>\n\nReceived. Uploading to the local processing server…`, parse_mode: 'HTML', reply_markup: categoryKeyboard });
      return;
    } catch (error) {
      console.error('Isolated worker unavailable; using fallback:', error);
    }
  }

  let result: ClassificationResult;
  try {
    const file = await telegram<{ file_path: string }>('getFile', { file_id: document.file_id });
    result = await classifyRemotePdf(document, file.file_path);
  } catch (error) {
    console.error('PDF classification failed:', error);
    result = { type: 'Needs inspection', strategy: 'failed', bytesRead: 0, pagesSampled: 0, reason: String(error).slice(0, 240) };
  }
  await finishDocument(context, result);
}

export async function workerCallbackHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (PDFBOT_CALLBACK_SECRET && req.headers['x-pdfbot-worker-secret'] !== PDFBOT_CALLBACK_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const payload = req.body as { status?: string; stage?: string; message?: string; classification?: Classification; strategy?: string; bytes_read?: number; pages_sampled?: number; context?: WorkerContext };
    const context = payload.context;
    if (!context) return res.status(400).json({ ok: false, error: 'Missing worker context' });
    if (payload.status === 'processing') {
      await telegram('editMessageText', { chat_id: context.chatId, message_id: context.progressMessageId, text: `<b>${escapeHtml(truncate(context.title, 180))}</b>\n\n${escapeHtml(payload.message || payload.stage || 'Processing…')}`, parse_mode: 'HTML', reply_markup: categoryKeyboard });
    } else {
      await finishDocument(context, { type: payload.classification || 'Needs inspection', strategy: payload.strategy || 'local-worker', bytesRead: payload.bytes_read || 0, pagesSampled: payload.pages_sampled || 0 });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Worker callback failed:', error);
    return res.status(200).json({ ok: true });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'telegram-pdf-classifier' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!BOT_TOKEN || !CHANNEL_ID) return res.status(503).json({ ok: false, error: 'Telegram credentials are not configured yet.' });
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const update = req.body as TelegramUpdate;
    if (update.callback_query?.data?.startsWith('list:')) {
      const requestedType = update.callback_query.data.slice(5);
      if (requestedType !== 'Scanned' && requestedType !== 'Selectable') {
        await telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Unknown category.' });
      } else {
        await telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id });
        if (update.callback_query.message) await sendCategoryList(update.callback_query.message.chat.id, requestedType);
      }
    } else if (update.message?.document) {
      const mime = update.message.document.mime_type || '';
      const filename = update.message.document.file_name || '';
      if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) await processDocument(update.message);
      else await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Please send a PDF document.' });
    } else if (update.message?.text === '/scanned' || update.message?.text === '/selectable' || update.message?.text === '/selective') {
      const type = update.message.text === '/scanned' ? 'Scanned' : 'Selectable';
      await sendCategoryList(update.message.chat.id, type);
    } else if (update.message?.text === '/start' || update.message?.text === '/help') {
      await telegram('sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Send me a PDF. I will classify it as Selectable or Scanned, forward it to the channel, and let you browse each category with the buttons below.',
        reply_markup: categoryKeyboard,
      });
    } else if (update.message) {
      await telegram('sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Send me a PDF and I will classify it as Selectable or Scanned.',
        reply_markup: categoryKeyboard,
      });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    // Always acknowledge the webhook so Telegram does not retry a completed update indefinitely.
    return res.status(200).json({ ok: true });
  }
}
