import type { VercelRequest, VercelResponse } from '@vercel/node';
import { classifyRemotePdf } from './remote-pdf.js';
import { clearAllData, clearContentData, createCategory, deleteCategory, exportBackup, getChatActiveCategory, listCategories, listRecords as listParadoxRecords, moveCategory, renameCategory, restoreBackup, savePending as saveParadoxPending, setChatActiveCategory, type Category as StoredCategory } from './store.js';

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
const TELEGRAM_FILE_BASE_URL = (process.env.TELEGRAM_FILE_BASE_URL || `${TELEGRAM_API_BASE.replace(/\/bot$/, '')}/file`).replace(/\/$/, '');
const PDFBOT_WORKER_URL = process.env.PDFBOT_WORKER_URL?.replace(/\/$/, '');
const PDFBOT_WORKER_SECRET = process.env.PDFBOT_WORKER_SECRET;
const PDFBOT_CALLBACK_URL = process.env.PDFBOT_CALLBACK_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/worker-callback` : undefined);
const PDFBOT_CALLBACK_SECRET = process.env.PDFBOT_CALLBACK_SECRET || WEBHOOK_SECRET;
const FORWARD_MAX_RETRIES = Math.max(1, Number(process.env.PDFBOT_FORWARD_MAX_RETRIES || 5));
const FORWARD_BASE_DELAY_MS = Math.max(250, Number(process.env.PDFBOT_FORWARD_BASE_DELAY_MS || 1500));
const FORWARD_QUEUE_LIMIT = Math.max(1, Number(process.env.PDFBOT_FORWARD_QUEUE_LIMIT || 100));

 type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
 type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
 type TelegramChat = { id: number; username?: string; title?: string };
 type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  document?: TelegramDocument;
  text?: string;
  reply_to_message?: TelegramMessage;
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
  categoryId?: string | null;
  strategy?: string;
  bytesRead?: number;
  pagesSampled?: number;
};

const BOT_UI = {
  pageSize: 8,
  labels: {
    browse: 'Browse categories',
    scanned: 'Scanned PDFs',
    selectable: 'Selectable PDFs',
    all: 'All PDFs',
    help: 'Help',
    home: 'Home',
    back: 'Back',
    root: 'Root categories',
  },
};
 type TelegramResponseMessage = { message_id: number };

function homeKeyboard() {
  return { inline_keyboard: [
    [{ text: `📂 ${BOT_UI.labels.browse}`, callback_data: 'menu:browse' }],
    [{ text: `📗 ${BOT_UI.labels.selectable}`, callback_data: 'type:Selectable:0' }, { text: `🖼 ${BOT_UI.labels.scanned}`, callback_data: 'type:Scanned:0' }],
    [{ text: `📚 ${BOT_UI.labels.all}`, callback_data: 'type:all:0' }, { text: `⚙ Settings`, callback_data: 'menu:settings' }],
    [{ text: `❔ ${BOT_UI.labels.help}`, callback_data: 'menu:help' }],
  ] };
}

const categoryKeyboard = homeKeyboard();

type PendingCategoryAction = { kind: 'create'; parentId: string | null; expiresAt: number } | { kind: 'rename'; categoryId: string; expiresAt: number };
const pendingCategoryActions = new Map<number, PendingCategoryAction>();
const pendingRestoreChats = new Set<number>();
const activeCategoryMemory = new Map<number, string | null>();

async function setActiveCategory(chatId: number, categoryId: string | null): Promise<void> {
  activeCategoryMemory.set(chatId, categoryId);
  if (PARADOX_ENABLED) await setChatActiveCategory(chatId, categoryId);
}

async function getActiveCategory(chatId: number): Promise<string | null> {
  if (PARADOX_ENABLED) return getChatActiveCategory(chatId);
  return activeCategoryMemory.get(chatId) || null;
}

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

function settingsKeyboard() {
  return { inline_keyboard: [
    [{ text: '💾 Back up saved file', callback_data: 'settings:backup' }],
    [{ text: '📤 Restore from file', callback_data: 'settings:restore' }],
    [{ text: '🗑 Clear data', callback_data: 'settings:clear' }],
    [{ text: '↩ Home', callback_data: 'menu:home' }],
  ] };
}

function clearDataKeyboard() {
  return { inline_keyboard: [
    [{ text: '🧹 Clear content', callback_data: 'settings:clear:content' }],
    [{ text: '⚠ Clear all data', callback_data: 'settings:clear:all' }],
    [{ text: '↩ Back to Settings', callback_data: 'menu:settings' }],
  ] };
}

function clearConfirmationKeyboard(kind: 'content' | 'all') {
  return { inline_keyboard: [[
    { text: kind === 'content' ? 'Yes, clear content' : 'Yes, clear all data', callback_data: `settings:clear:${kind}:yes` },
    { text: 'Cancel', callback_data: 'settings:clear:no' },
  ]] };
}

async function sendTelegramBackup(chatId: number): Promise<void> {
  if (!PARADOX_ENABLED) throw new Error('Paradox-DB is not configured');
  const backup = await exportBackup();
  const filename = `telegram-pdf-bot-backup-${backup.exported_at.replace(/[:.]/g, '-')}.json`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `PDF Bot backup\n${backup.pdf_records.length} PDF record(s), ${backup.categories.length} categor(y/ies)\nSnapshot: ${backup.exported_at}`);
  form.append('document', new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), filename);
  const response = await fetch(`${TELEGRAM_API_URL}/sendDocument`, { method: 'POST', body: form });
  const result = await response.json() as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || 'Telegram backup upload failed');
}

async function restoreTelegramBackup(chatId: number, document: TelegramDocument): Promise<void> {
  if (!PARADOX_ENABLED) throw new Error('Paradox-DB is not configured');
  const file = await telegram<{ file_path: string }>('getFile', { file_id: document.file_id });
  const response = await fetch(`${TELEGRAM_FILE_BASE_URL}/${file.file_path}`);
  if (!response.ok) throw new Error(`Could not download the backup file (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Backup file is larger than the 20 MB safety limit');
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Backup file is not valid JSON'); }
  await restoreBackup(payload);
  await setActiveCategory(chatId, null);
}

async function sendSettings(chatId: number, editMessageId?: number): Promise<void> {
  const text = '<b>Settings</b>\n\nBackups are point-in-time snapshots of PDF metadata and category structure. Restore replaces the current metadata and categories. Clear permanently deletes them after confirmation.';
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: settingsKeyboard() };
  if (editMessageId) await telegram('editMessageText', { ...payload, message_id: editMessageId });
  else await telegram('sendMessage', payload);
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
        categoryId: record.category_id,
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

async function sendHome(chatId: number, editMessageId?: number): Promise<void> {
  await setActiveCategory(chatId, null);
  const text = '<b>PDF Library</b>\n\nChoose an action below, or send me a PDF to classify and archive it.';
  if (editMessageId) {
    await telegram('editMessageText', { chat_id: chatId, message_id: editMessageId, text, parse_mode: 'HTML', reply_markup: homeKeyboard() });
  } else {
    await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: homeKeyboard() });
  }
}

async function sendHelp(chatId: number, editMessageId?: number): Promise<void> {
  const text = '<b>How to use PDF Library</b>\n\n• Send a PDF to classify and forward it.\n• Browse categories to open nested folders.\n• Use Scanned, Selectable, or All PDFs to browse by type.\n• Use /menu to reopen this menu.\n• Use /categories to open the category tree.';
  const markup = { inline_keyboard: [[{ text: `↩ ${BOT_UI.labels.home}`, callback_data: 'menu:home' }]] };
  if (editMessageId) await telegram('editMessageText', { chat_id: chatId, message_id: editMessageId, text, parse_mode: 'HTML', reply_markup: markup });
  else await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup });
}

function pageKeyboard(prefix: string, page: number, pageCount: number, backData = 'menu:home') {
  const row: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) row.push({ text: '‹ Previous', callback_data: `${prefix}:${page - 1}` });
  if (page + 1 < pageCount) row.push({ text: 'Next ›', callback_data: `${prefix}:${page + 1}` });
  const rows = row.length ? [row] : [];
  rows.push([{ text: `↩ ${BOT_UI.labels.back}`, callback_data: backData }, { text: `⌂ ${BOT_UI.labels.home}`, callback_data: 'menu:home' }]);
  return { inline_keyboard: rows };
}

async function sendRecordPage(chatId: number, entries: RecordEntry[], title: string, page: number, prefix: string, backData = 'menu:home', editMessageId?: number): Promise<void> {
  const pageCount = Math.max(1, Math.ceil(entries.length / BOT_UI.pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageEntries = entries.slice(safePage * BOT_UI.pageSize, (safePage + 1) * BOT_UI.pageSize);
  const body = pageEntries.length
    ? pageEntries.map((entry, index) => `${safePage * BOT_UI.pageSize + index + 1}. <a href="${escapeHtml(entry.channelUrl)}">${escapeHtml(truncate(entry.title, 150))}</a>\n   ${escapeHtml(truncate(entry.sender, 100))} · ${escapeHtml(entry.type)}`).join('\n\n')
    : 'No PDFs found in this view.';
  const text = `<b>${escapeHtml(title)}</b>\n\n${body}\n\nPage ${safePage + 1}/${pageCount} · ${entries.length} PDF(s)`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: pageKeyboard(prefix, safePage, pageCount, backData) };
  if (editMessageId) await telegram('editMessageText', { ...payload, message_id: editMessageId });
  else await telegram('sendMessage', payload);
}

async function sendTypeList(chatId: number, type: 'Scanned' | 'Selectable' | 'all', page = 0, editMessageId?: number): Promise<void> {
  const { entries } = await readGithubLog();
  const filtered = type === 'all' ? entries : entries.filter((entry) => entry.type === type);
  await sendRecordPage(chatId, filtered.reverse(), type === 'all' ? BOT_UI.labels.all : `${type} PDFs`, page, `type:${type}`, 'menu:home', editMessageId);
}

async function sendCategoryBrowser(chatId: number, parentId: string | null, editMessageId?: number): Promise<void> {
  await setActiveCategory(chatId, parentId);
  if (!PARADOX_ENABLED) {
    const text = 'Nested categories require Paradox-DB to be enabled.';
    if (editMessageId) await telegram('editMessageText', { chat_id: chatId, message_id: editMessageId, text, reply_markup: homeKeyboard() });
    else await telegram('sendMessage', { chat_id: chatId, text, reply_markup: homeKeyboard() });
    return;
  }
  const categories = await listCategories();
  const current = parentId ? categories.find((category) => category.id === parentId) : undefined;
  const children = categories.filter((category) => (category.parent_id || null) === parentId);
  const { entries } = await readGithubLog();
  const inFolder = entries.filter((entry) => (entry.categoryId || null) === parentId);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < children.length; index += 2) {
    rows.push(children.slice(index, index + 2).map((category) => ({ text: `📁 ${truncate(category.name, 28)}`, callback_data: `cat:${category.id}` })));
  }
  if (inFolder.length) rows.push([{ text: `📄 PDFs in this folder (${inFolder.length})`, callback_data: `catpage:${parentId || 'root'}:0` }]);
  rows.push([{ text: '➕ Create category here', callback_data: `catcreate:${parentId || 'root'}` }, { text: '↔ Move category here', callback_data: `catmove:${parentId || 'root'}` }]);
  if (current) rows.push([{ text: '↳ Nest this category', callback_data: `catnest:${current.id}` }, { text: '✎ Rename', callback_data: `catrename:${current.id}` }, { text: '🗑 Delete', callback_data: `catdelete:${current.id}` }]);
  if (parentId) rows.push([{ text: `↩ ${BOT_UI.labels.back}`, callback_data: current?.parent_id ? `cat:${current.parent_id}` : 'menu:browse' }, { text: `⌂ ${BOT_UI.labels.home}`, callback_data: 'menu:home' }]);
  else rows.push([{ text: `⌂ ${BOT_UI.labels.home}`, callback_data: 'menu:home' }]);
  const title = current ? `📂 ${current.name}` : `📂 ${BOT_UI.labels.root}`;
  const text = `<b>${escapeHtml(title)}</b>\n\n${children.length ? 'Choose a subcategory:' : 'No subcategories here yet.'}${inFolder.length ? `\nThis folder contains ${inFolder.length} PDF(s).` : ''}`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (editMessageId) await telegram('editMessageText', { ...payload, message_id: editMessageId });
  else await telegram('sendMessage', payload);
}

async function sendNestCategoryMenu(chatId: number, sourceId: string, editMessageId?: number): Promise<void> {
  if (!PARADOX_ENABLED) return sendCategoryBrowser(chatId, null, editMessageId);
  const categories = await listCategories();
  const source = categories.find((category) => category.id === sourceId);
  if (!source) return sendCategoryBrowser(chatId, null, editMessageId);
  const descendantIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (category.parent_id === sourceId || (category.parent_id && descendantIds.has(category.parent_id))) {
        if (!descendantIds.has(category.id)) { descendantIds.add(category.id); changed = true; }
      }
    }
  }
  const candidates = categories.filter((category) => category.id !== sourceId && !descendantIds.has(category.id));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([{ text: '📁 Root', callback_data: `nesttarget:${sourceId}:root` }]);
  for (let index = 0; index < candidates.length; index += 2) {
    rows.push(candidates.slice(index, index + 2).map((category) => ({ text: `📁 ${truncate(category.name, 26)}`, callback_data: `nesttarget:${sourceId}:${category.id}` })));
  }
  rows.push([{ text: 'Cancel', callback_data: `cat:${sourceId}` }]);
  const text = `<b>Nest ${escapeHtml(source.name)}</b>\n\nChoose the category that should contain it. Invalid descendant destinations are hidden.`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (editMessageId) await telegram('editMessageText', { ...payload, message_id: editMessageId });
  else await telegram('sendMessage', payload);
}

async function sendMoveCategoryMenu(chatId: number, targetParentId: string | null, editMessageId?: number): Promise<void> {
  if (!PARADOX_ENABLED) return sendCategoryBrowser(chatId, targetParentId, editMessageId);
  const categories = await listCategories();
  const target = targetParentId ? categories.find((category) => category.id === targetParentId) : undefined;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const candidates = categories.filter((category) => category.id !== targetParentId);
  for (let index = 0; index < candidates.length; index += 2) {
    rows.push(candidates.slice(index, index + 2).map((category) => ({ text: `📁 ${truncate(category.name, 26)}`, callback_data: `movesource:${category.id}:${targetParentId || 'root'}` })));
  }
  rows.push([{ text: 'Cancel', callback_data: targetParentId ? `cat:${targetParentId}` : 'menu:browse' }]);
  const text = `<b>Move a category into ${escapeHtml(target?.name || BOT_UI.labels.root)}</b>\n\nChoose the category to move. The system will block invalid moves into itself or its descendants.`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
  if (editMessageId) await telegram('editMessageText', { ...payload, message_id: editMessageId });
  else await telegram('sendMessage', payload);
}

async function handlePendingCategoryText(message: TelegramMessage): Promise<boolean> {
  if (!message.text) return false;
  const pending = pendingCategoryActions.get(message.chat.id);
  if (!pending) return false;
  pendingCategoryActions.delete(message.chat.id);
  if (pending.expiresAt < Date.now() || message.text.trim() === '/cancel') {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Category operation cancelled.', reply_markup: homeKeyboard() });
    return true;
  }
  try {
    if (pending.kind === 'rename') {
      await renameCategory(pending.categoryId, message.text.trim().slice(0, 80));
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Category renamed successfully.' });
      const categories = await listCategories();
      const category = categories.find((item) => item.id === pending.categoryId);
      await sendCategoryBrowser(message.chat.id, category?.parent_id || null);
    } else {
      const category = await createCategory(message.text.trim().slice(0, 80), pending.parentId);
      await telegram('sendMessage', { chat_id: message.chat.id, text: `Created category <b>${escapeHtml(category.name)}</b>.`, parse_mode: 'HTML' });
      await sendCategoryBrowser(message.chat.id, pending.parentId);
    }
  } catch (error) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: `Category operation failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: homeKeyboard() });
  }
  return true;
}

async function sendCategoryRecords(chatId: number, categoryId: string | null, page: number, editMessageId?: number): Promise<void> {
  await setActiveCategory(chatId, categoryId);
  const categories = PARADOX_ENABLED ? await listCategories() : [];
  const category = categoryId ? categories.find((item) => item.id === categoryId) : undefined;
  const { entries } = await readGithubLog();
  const filtered = entries.filter((entry) => (entry.categoryId || null) === categoryId).reverse();
  await sendRecordPage(chatId, filtered, category ? `📂 ${category.name}` : `📂 ${BOT_UI.labels.root}`, page, `catpage:${categoryId || 'root'}`, category?.parent_id ? `cat:${category.parent_id}` : 'menu:browse', editMessageId);
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
  categoryId: string | null;
  title: string;
  sender: string;
  recordId: string;
};

type ClassificationResult = { type: Classification; strategy: string; bytesRead: number; pagesSampled: number; reason?: string };

type ForwardJob = { context: WorkerContext; result: ClassificationResult };
const forwardQueue: ForwardJob[] = [];
const forwardQueuedIds = new Set<string>();
let forwardQueueRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueForward(job: ForwardJob): boolean {
  if (forwardQueuedIds.has(job.context.recordId)) return true;
  if (forwardQueue.length >= FORWARD_QUEUE_LIMIT) return false;
  forwardQueue.push(job);
  forwardQueuedIds.add(job.context.recordId);
  void drainForwardQueue();
  return true;
}

async function processForwardJob({ context, result }: ForwardJob): Promise<void> {
  if (!CHANNEL_ID) throw new Error('TELEGRAM_CHANNEL_ID is not configured');
  let copied: TelegramResponseMessage | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= FORWARD_MAX_RETRIES; attempt += 1) {
    try {
      copied = await telegram<TelegramResponseMessage>('copyMessage', { chat_id: CHANNEL_ID, from_chat_id: context.chatId, message_id: context.sourceMessageId });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < FORWARD_MAX_RETRIES) await sleep(FORWARD_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  if (!copied) throw lastError instanceof Error ? lastError : new Error('Channel forwarding failed');

  const sourceUrl = channelMessageUrl(copied.message_id);
  const caption = [
    `<b>Title:</b> ${escapeHtml(truncate(context.title, 400))}`,
    `<b>Type:</b> ${escapeHtml(result.type)}`,
    `<b>Sender:</b> ${escapeHtml(truncate(context.sender, 250))}`,
    `<b>Strategy:</b> ${escapeHtml(result.strategy)}`,
    context.categoryId ? `<b>Category:</b> ${escapeHtml(context.categoryId)}` : '',
    `<a href="${escapeHtml(sourceUrl)}">Open PDF</a>`,
  ].filter(Boolean).join('\n');
  try {
    await telegram('editMessageCaption', { chat_id: CHANNEL_ID, message_id: copied.message_id, caption, parse_mode: 'HTML', reply_markup: categoryKeyboard });
  } catch (error) {
    console.error('Channel caption or button update failed:', error);
  }
  const entry: RecordEntry = {
    id: context.recordId, title: context.title, sender: context.sender, senderId: context.senderId,
    type: result.type, channelUrl: sourceUrl, receivedAt: new Date().toISOString(), categoryId: context.categoryId,
    strategy: result.strategy, bytesRead: result.bytesRead, pagesSampled: result.pagesSampled,
  };
  if (PARADOX_ENABLED) {
    await saveParadoxPending({ id: context.recordId, title: context.title, sender: context.sender, sender_id: context.senderId, classification: result.type, source_url: sourceUrl, received_at: entry.receivedAt, strategy: result.strategy, bytes_read: result.bytesRead, pages_sampled: result.pagesSampled, metadata_message_id: copied.message_id, category_id: context.categoryId });
  } else {
    const log = await readGithubLog();
    await writeGithubLog([...log.entries, entry], log.sha);
  }
  await telegram('sendMessage', { chat_id: context.chatId, text: `Forwarded successfully. The PDF is now indexed in the channel.\nQueue completed: ${context.title}`, reply_markup: categoryKeyboard });
}

async function drainForwardQueue(): Promise<void> {
  if (forwardQueueRunning) return;
  forwardQueueRunning = true;
  try {
    while (forwardQueue.length) {
      const job = forwardQueue.shift()!;
      try {
        await processForwardJob(job);
      } catch (error) {
        console.error('Queued channel forwarding failed:', error);
        await telegram('sendMessage', { chat_id: job.context.chatId, text: `Forwarding failed after ${FORWARD_MAX_RETRIES} attempts. The PDF remains classified, but it was not copied to the channel. Please check channel permissions and retry the queued item later.`, reply_markup: categoryKeyboard }).catch((notificationError) => console.error('Forward failure notification failed:', notificationError));
      } finally {
        forwardQueuedIds.delete(job.context.recordId);
      }
    }
  } finally {
    forwardQueueRunning = false;
    if (forwardQueue.length) void drainForwardQueue();
  }
}

async function finishDocument(context: WorkerContext, result: ClassificationResult): Promise<void> {
  await updateUserResult(context.chatId, context.progressMessageId, context.title, result);
  const queued = enqueueForward({ context, result });
  if (queued) {
    await telegram('sendMessage', { chat_id: context.chatId, text: `Classification complete. Forwarding queued (position ${forwardQueue.length}). The channel copy will be retried automatically if Telegram is busy.`, reply_markup: categoryKeyboard });
  } else {
    await telegram('sendMessage', { chat_id: context.chatId, text: 'Classification complete, but the forwarding queue is currently full. The PDF was not forwarded; please retry after the queue drains.', reply_markup: categoryKeyboard });
  }
}

async function processDocument(message: TelegramMessage): Promise<void> {
  const document = message.document!;
  const title = document.file_name || 'Untitled PDF';
  const activeCategoryId = await getActiveCategory(message.chat.id);
  const context: WorkerContext = { chatId: message.chat.id, progressMessageId: 0, sourceMessageId: message.message_id, senderId: message.from?.id || 0, categoryId: activeCategoryId, title, sender: senderName(message.from), recordId: `${Date.now()}-${message.message_id}` };
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
    if (update.callback_query?.data) {
      const query = update.callback_query;
      const data = query.data || '';
      const chatId = query.message?.chat.id;
      await telegram('answerCallbackQuery', { callback_query_id: query.id });
      if (!chatId) return res.status(200).json({ ok: true });
      if (data === 'menu:home') await sendHome(chatId, query.message?.message_id);
      else if (data === 'menu:help') await sendHelp(chatId, query.message?.message_id);
      else if (data === 'menu:settings') await sendSettings(chatId, query.message?.message_id);
      else if (data === 'settings:backup') {
        try { await sendTelegramBackup(chatId); } catch (error) { await telegram('sendMessage', { chat_id: chatId, text: `Backup failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: settingsKeyboard() }); }
      } else if (data === 'settings:restore') {
        pendingRestoreChats.add(chatId);
        await telegram('sendMessage', { chat_id: chatId, text: 'Send the JSON backup file produced by this bot. Restore replaces the current PDF metadata and category structure. Send /cancel to stop.', reply_markup: { force_reply: true, input_field_placeholder: 'Upload backup JSON' } });
      } else if (data === 'settings:clear') {
        await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: '<b>Choose what to clear</b>\n\n<b>Clear content</b> deletes saved PDF records but keeps all categories and subcategories.\n\n<b>Clear all data</b> deletes PDF records and the complete category structure.', parse_mode: 'HTML', reply_markup: clearDataKeyboard() });
      } else if (data === 'settings:clear:content') {
        await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: '<b>Clear content?</b>\n\nThis deletes all saved PDF records and clears their assignments, but preserves every category and subcategory.', parse_mode: 'HTML', reply_markup: clearConfirmationKeyboard('content') });
      } else if (data === 'settings:clear:all') {
        await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: '<b>Clear all data?</b>\n\nThis permanently removes every PDF record, category, subcategory, and active upload destination. This cannot be undone unless you have a backup.', parse_mode: 'HTML', reply_markup: clearConfirmationKeyboard('all') });
      } else if (data === 'settings:clear:content:yes') {
        try { await clearContentData(); activeCategoryMemory.clear(); await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: 'All saved PDF content has been cleared. Your category and subcategory structure was preserved.', reply_markup: homeKeyboard() }); } catch (error) { await telegram('sendMessage', { chat_id: chatId, text: `Clear content failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: settingsKeyboard() }); }
      } else if (data === 'settings:clear:all:yes') {
        try { await clearAllData(); activeCategoryMemory.clear(); await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: 'All PDF records, categories, subcategories, and active destinations have been cleared.', reply_markup: homeKeyboard() }); } catch (error) { await telegram('sendMessage', { chat_id: chatId, text: `Clear all failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: settingsKeyboard() }); }
      } else if (data === 'settings:clear:no') {
        await sendSettings(chatId, query.message?.message_id);
      } else if (data === 'menu:browse') await sendCategoryBrowser(chatId, null, query.message?.message_id);
      else if (data.startsWith('catnest:')) {
        await sendNestCategoryMenu(chatId, data.slice(8), query.message?.message_id);
      } else if (data.startsWith('nesttarget:')) {
        const [, sourceId, targetText] = data.split(':');
        try {
          await moveCategory(sourceId, targetText === 'root' ? null : targetText);
          await telegram('sendMessage', { chat_id: chatId, text: 'Category nested successfully.' });
          await sendCategoryBrowser(chatId, targetText === 'root' ? null : targetText);
        } catch (error) {
          await telegram('sendMessage', { chat_id: chatId, text: `Could not nest category: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: homeKeyboard() });
        }
      } else if (data.startsWith('catrename:')) {
        const categoryId = data.slice(10);
        pendingCategoryActions.set(chatId, { kind: 'rename', categoryId, expiresAt: Date.now() + 5 * 60 * 1000 });
        await telegram('sendMessage', { chat_id: chatId, text: 'Type the new category name. Send /cancel to stop.', reply_markup: { force_reply: true, input_field_placeholder: 'New category name' } });
      } else if (data.startsWith('catdelete:yes:')) {
        const categoryId = data.slice(14);
        try {
          const categories = await listCategories();
          const category = categories.find((item) => item.id === categoryId);
          await deleteCategory(categoryId);
          await setActiveCategory(chatId, category?.parent_id || null);
          await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: `Deleted category <b>${escapeHtml(category?.name || 'category')}</b>. Its subcategories were moved to the former parent and its PDFs were unassigned.`, parse_mode: 'HTML', reply_markup: homeKeyboard() });
        } catch (error) {
          await telegram('sendMessage', { chat_id: chatId, text: `Could not delete category: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: homeKeyboard() });
        }
      } else if (data.startsWith('catdelete:no:')) {
        await sendCategoryBrowser(chatId, data.slice(13), query.message?.message_id);
      } else if (data.startsWith('catdelete:')) {
        const categoryId = data.slice(10);
        const categories = await listCategories();
        const category = categories.find((item) => item.id === categoryId);
        await telegram('editMessageText', { chat_id: chatId, message_id: query.message?.message_id, text: `<b>Delete ${escapeHtml(category?.name || 'this category')}?</b>\n\nIts subcategories will move to the former parent and its PDFs will become unassigned.`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Yes, delete', callback_data: `catdelete:yes:${categoryId}` }, { text: 'Cancel', callback_data: `catdelete:no:${categoryId}` }]] } });
      } else if (data.startsWith('catcreate:')) {
        if (!PARADOX_ENABLED) await telegram('sendMessage', { chat_id: chatId, text: 'Category management requires Paradox-DB to be enabled.', reply_markup: homeKeyboard() });
        else {
          const parentText = data.slice(10);
          pendingCategoryActions.set(chatId, { kind: 'create', parentId: parentText === 'root' ? null : parentText, expiresAt: Date.now() + 5 * 60 * 1000 });
          await telegram('sendMessage', { chat_id: chatId, text: 'Type the new category name. Send /cancel to stop.', reply_markup: { force_reply: true, input_field_placeholder: 'Category name' } });
        }
      } else if (data.startsWith('catmove:')) {
        const targetText = data.slice(8);
        await sendMoveCategoryMenu(chatId, targetText === 'root' ? null : targetText, query.message?.message_id);
      } else if (data.startsWith('movesource:')) {
        const [, sourceId, targetText] = data.split(':');
        try {
          await moveCategory(sourceId, targetText === 'root' ? null : targetText);
          await telegram('sendMessage', { chat_id: chatId, text: 'Category moved successfully.' });
          await sendCategoryBrowser(chatId, targetText === 'root' ? null : targetText);
        } catch (error) {
          await telegram('sendMessage', { chat_id: chatId, text: `Could not move category: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: homeKeyboard() });
        }
      } else if (data.startsWith('type:')) {
        const [, requestedType, pageText] = data.split(':');
        const requested = requestedType === 'Scanned' || requestedType === 'Selectable' || requestedType === 'all' ? requestedType : 'all';
        await sendTypeList(chatId, requested, Number(pageText) || 0, query.message?.message_id);
      } else if (data.startsWith('catpage:')) {
        const [, categoryText, pageText] = data.split(':');
        await sendCategoryRecords(chatId, categoryText === 'root' ? null : categoryText, Number(pageText) || 0, query.message?.message_id);
      } else if (data.startsWith('cat:')) {
        await sendCategoryBrowser(chatId, data.slice(4), query.message?.message_id);
      } else if (data.startsWith('list:')) {
        const requestedType = data.slice(5) === 'Scanned' ? 'Scanned' : 'Selectable';
        await sendTypeList(chatId, requestedType, 0, query.message?.message_id);
      }
    } else if (update.message?.text === '/cancel' && pendingRestoreChats.has(update.message.chat.id)) {
      pendingRestoreChats.delete(update.message.chat.id);
      await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Restore cancelled.', reply_markup: settingsKeyboard() });
    } else if (update.message?.document && pendingRestoreChats.has(update.message.chat.id)) {
      pendingRestoreChats.delete(update.message.chat.id);
      try { await restoreTelegramBackup(update.message.chat.id, update.message.document); await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Backup restored successfully. The current PDF metadata and category structure now match the uploaded snapshot.', reply_markup: homeKeyboard() }); } catch (error) { await telegram('sendMessage', { chat_id: update.message.chat.id, text: `Restore failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`, parse_mode: 'HTML', reply_markup: settingsKeyboard() }); }
    } else if (update.message?.text && await handlePendingCategoryText(update.message)) {
      // Category creation reply was handled above.
    } else if (update.message?.document) {
      const mime = update.message.document.mime_type || '';
      const filename = update.message.document.file_name || '';
      if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) await processDocument(update.message);
      else await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Please send a PDF document.' });
    } else if (update.message?.text === '/scanned' || update.message?.text === '/selectable' || update.message?.text === '/selective') {
      const type = update.message.text === '/scanned' ? 'Scanned' : 'Selectable';
      await sendTypeList(update.message.chat.id, type, 0);
    } else if (update.message?.text === '/categories' || update.message?.text === '/browse') {
      await sendCategoryBrowser(update.message.chat.id, null);
    } else if (update.message?.text === '/settings') {
      await sendSettings(update.message.chat.id);
    } else if (update.message?.text === '/menu' || update.message?.text === '/start') {
      await sendHome(update.message.chat.id);
    } else if (update.message?.text === '/help') {
      await sendHelp(update.message.chat.id);
    } else if (update.message) {
      await telegram('sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Send me a PDF and I will classify it as Selectable or Scanned.',
        reply_markup: homeKeyboard(),
      });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    // Always acknowledge the webhook so Telegram does not retry a completed update indefinitely.
    return res.status(200).json({ ok: true });
  }
}
