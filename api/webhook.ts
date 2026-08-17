import type { VercelRequest, VercelResponse } from '@vercel/node';
import { classifyRemotePdf } from './remote-pdf.js';
import { listRecords as listParadoxRecords, savePending as saveParadoxPending, updateRecord as updateParadoxRecord } from './store.js';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME?.replace(/^@/, '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://telegram-bot-api-gl9q.onrender.com/bot').replace(/\/$/, '');
const PARADOX_ENABLED = Boolean(process.env.PARADOX_API_KEY && process.env.PARADOX_PASSPHRASE);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_LOG_PATH = process.env.GITHUB_LOG_PATH || 'data/pdf-dashboard.md';

const telegramBase = `${TELEGRAM_API_BASE}${BOT_TOKEN || ''}`;

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
type TelegramMessage = { message_id: number; chat: { id: number; username?: string; title?: string }; from?: TelegramUser; document?: TelegramDocument; text?: string; date: number };
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: { id: string; data?: string; from: TelegramUser; message?: TelegramMessage } };

type RecordEntry = {
  id: string;
  title: string;
  sender: string;
  senderId: number;
  type: 'Scanned' | 'Selectable' | 'Needs inspection';
  channelUrl: string;
  receivedAt: string;
  strategy?: string;
  bytesRead?: number;
  pagesSampled?: number;
};

async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${telegramBase}/${method}`, {
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

function markdown(entries: RecordEntry[]): string {
  const header = '# PDF Dashboard\n\n| Title | Sender | Type | Telegram source | Received |\n|---|---|---|---|---|\n';
  const rows = entries.map((entry) => `| ${escapeCell(entry.title)} | ${escapeCell(entry.sender)} | **${entry.type}** | [Open PDF](${entry.channelUrl}) | ${entry.receivedAt} |`).join('\n');
  return `${header}${rows}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/[|\n\r]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function readGithubLog(): Promise<{ entries: RecordEntry[]; sha?: string }> {
  if (PARADOX_ENABLED) {
    const records = await listParadoxRecords();
    return { entries: records.map((record: any) => ({ id: record.id, title: record.title, sender: record.sender, senderId: record.sender_id, type: record.classification, channelUrl: record.source_url, receivedAt: record.received_at, strategy: record.strategy, bytesRead: record.bytes_read, pagesSampled: record.pages_sampled })) };
  }
  if (!GITHUB_TOKEN || !GITHUB_REPO) return { entries: [] };
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_LOG_PATH}`, {
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'telegram-pdf-classifier' },
  });
  if (response.status === 404) return { entries: [] };
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
  const file = await response.json() as { content: string; sha: string };
  const content = Buffer.from(file.content, 'base64').toString('utf8');
  const entries: RecordEntry[] = [];
  for (const line of content.split('\n').slice(3)) {
    const match = line.match(/^\| (.*?) \| (.*?) \| \*\*(Scanned|Selectable|Needs inspection)\*\* \| \[Open PDF\]\((.*?)\) \| (.*?) \|$/);
    if (match) entries.push({ id: `${entries.length}`, title: match[1], sender: match[2], senderId: 0, type: match[3] as RecordEntry['type'], channelUrl: match[4], receivedAt: match[5] });
  }
  return { entries, sha: file.sha };
}

async function writeGithubLog(entries: RecordEntry[], sha?: string): Promise<void> {
  if (PARADOX_ENABLED) return;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const body: Record<string, unknown> = {
    message: `Record PDF: ${entries[entries.length - 1]?.title || 'update'}`,
    content: Buffer.from(markdown(entries), 'utf8').toString('base64'),
    branch: process.env.GITHUB_BRANCH || 'main',
  };
  if (sha) body.sha = sha;
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_LOG_PATH}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'telegram-pdf-classifier' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub write failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

async function sendCategoryList(chatId: number, type: RecordEntry['type']): Promise<void> {
  const { entries } = await readGithubLog();
  const filtered = entries.filter((entry) => entry.type === type).reverse();
  const text = filtered.length
    ? `*${type} PDFs*\n\n${filtered.map((entry, index) => `${index + 1}\. [${escapeMarkdown(entry.title)}](${entry.channelUrl}) — ${escapeMarkdown(entry.sender)}`).join('\n')}`
    : `No ${type.toLowerCase()} PDFs have been recorded yet.`;
  await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true });
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
}

async function processDocument(message: TelegramMessage): Promise<void> {
  const document = message.document!;
  const title = document.file_name || 'Untitled PDF';
  const recordId = `${Date.now()}-${message.message_id}`;
  const sender = senderName(message.from);
  const botKeyboard = { inline_keyboard: [[{ text: 'Scanned', callback_data: 'list:Scanned' }, { text: 'Selectable', callback_data: 'list:Selectable' }]] };

  let result: { type: RecordEntry['type']; strategy: string; bytesRead: number; pagesSampled: number };
  try {
    const file = await telegram<{ file_path: string }>('getFile', { file_id: document.file_id });
    result = await classifyRemotePdf(document, file.file_path);
  } catch (error) {
    console.error('PDF classification failed:', error);
    result = { type: 'Needs inspection', strategy: 'failed', bytesRead: 0, pagesSampled: 0 };
  }

  // Report the intended result to the user before attempting the channel operation.
  await telegram('sendMessage', {
    chat_id: message.chat.id,
    text: result.type === 'Needs inspection'
      ? `Received *${escapeMarkdown(title)}*.\\nClassification: *Needs inspection*.\\nThe PDF could not be classified completely.`
      : `Received *${escapeMarkdown(title)}*.\\nClassification: *${escapeMarkdown(result.type)}*.\\nChoose a category to list matching PDFs from the channel.`,
    parse_mode: 'MarkdownV2',
    reply_markup: botKeyboard,
  });

  let copied: { message_id: number };
  try {
    // Telegram copies the original document server-side; Vercel does not re-upload it.
    copied = await telegram<{ message_id: number }>('copyMessage', {
      chat_id: CHANNEL_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  } catch (error) {
    console.error('Channel forwarding failed:', error);
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: 'The PDF was classified, but I could not forward it to the configured channel. Please verify TELEGRAM_CHANNEL_ID and the bot administrator permissions.',
    });
    return;
  }

  const sourceUrl = channelMessageUrl(copied.message_id);
  const caption = `<b>Title:</b> ${escapeHtml(title)}\\n<b>Type:</b> ${escapeHtml(result.type)}\\n<b>Sender:</b> ${escapeHtml(sender)}\\n<b>Strategy:</b> ${escapeHtml(result.strategy)}\\n<a href="${sourceUrl}">Open PDF</a>`;
  try {
    await telegram('editMessageCaption', {
      chat_id: CHANNEL_ID,
      message_id: copied.message_id,
      caption,
      parse_mode: 'HTML',
    });
  } catch (error) {
    console.error('Channel caption update failed:', error);
  }

  const entry: RecordEntry = {
    id: recordId,
    title,
    sender,
    senderId: message.from?.id || 0,
    type: result.type,
    channelUrl: sourceUrl,
    receivedAt: new Date().toISOString(),
    strategy: result.strategy,
    bytesRead: result.bytesRead,
    pagesSampled: result.pagesSampled,
  };
  try {
    if (PARADOX_ENABLED) {
      await saveParadoxPending({ id: recordId, title, sender, sender_id: entry.senderId, classification: result.type, source_url: sourceUrl, received_at: entry.receivedAt, strategy: result.strategy, bytes_read: result.bytesRead, pages_sampled: result.pagesSampled, metadata_message_id: copied.message_id });
    } else {
      const log = await readGithubLog();
      await writeGithubLog([...log.entries, entry], log.sha);
    }
  } catch (error) {
    console.error('PDF record persistence failed:', error);
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
      const type = update.callback_query.data.slice(5) as RecordEntry['type'];
      await telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id });
      if (update.callback_query.message) await sendCategoryList(update.callback_query.message.chat.id, type);
    } else if (update.message?.document) {
      const mime = update.message.document.mime_type || '';
      const filename = update.message.document.file_name || '';
      if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) await processDocument(update.message);
      else await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Please send a PDF document.' });
    } else if (update.message?.text === '/scanned' || update.message?.text === '/selectable') {
      const type = update.message.text === '/scanned' ? 'Scanned' : 'Selectable';
      await sendCategoryList(update.message.chat.id, type);
    } else if (update.message) {
      await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Send me a PDF and I will classify it as Scanned or Selectable.' });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({ ok: true });
  }
}
