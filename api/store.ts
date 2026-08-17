import { connect, type ParadConnection } from 'parad';

let dbPromise: Promise<ParadConnection> | undefined;

async function openDb(): Promise<ParadConnection> {
  const db = await connect({
    name: process.env.PARADOX_DATABASE || 'pdf-records',
    dbPath: process.env.PARADOX_DB_PATH || '/tmp/pdf-records.paradox',
    project: process.env.PARADOX_PROJECT || 'telegram-pdf-bot',
    gatewayUrl: process.env.PARADOX_GATEWAY_URL || 'https://paradoxdb.onrender.com/v1',
    apiKey: process.env.PARADOX_API_KEY,
    passphrase: process.env.PARADOX_PASSPHRASE,
    autoSync: true,
    pullOnStartup: true,
  });
  db.execute(`CREATE TABLE IF NOT EXISTS pdf_records (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    classification TEXT NOT NULL,
    source_url TEXT NOT NULL,
    received_at TEXT NOT NULL,
    strategy TEXT,
    bytes_read INTEGER DEFAULT 0,
    pages_sampled INTEGER DEFAULT 0,
    metadata_message_id INTEGER NOT NULL,
    category_id TEXT
  )`);
  try { db.execute('ALTER TABLE pdf_records ADD COLUMN category_id TEXT'); } catch { /* existing schema already has it */ }
  db.execute(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return db;
}

export async function getDb(): Promise<ParadConnection> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export type PdfRecord = {
  id: string;
  title: string;
  sender: string;
  sender_id: number;
  classification: 'Scanned' | 'Selectable' | 'Needs inspection';
  source_url: string;
  received_at: string;
  strategy?: string;
  bytes_read?: number;
  pages_sampled?: number;
  metadata_message_id: number;
  category_id?: string | null;
};

export type Category = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export async function savePending(record: PdfRecord): Promise<void> {
  const db = await getDb();
  db.execute(`INSERT INTO pdf_records (id, title, sender, sender_id, classification, source_url, received_at, strategy, bytes_read, pages_sampled, metadata_message_id, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, sender=excluded.sender, sender_id=excluded.sender_id,
      classification=excluded.classification, source_url=excluded.source_url, received_at=excluded.received_at,
      strategy=excluded.strategy, bytes_read=excluded.bytes_read, pages_sampled=excluded.pages_sampled,
      metadata_message_id=excluded.metadata_message_id, category_id=excluded.category_id`,
    [record.id, record.title, record.sender, record.sender_id, record.classification, record.source_url, record.received_at, record.strategy || null, record.bytes_read || 0, record.pages_sampled || 0, record.metadata_message_id, record.category_id || null]);
}

export async function updateRecord(id: string, patch: Partial<PdfRecord>): Promise<void> {
  const allowed = ['title', 'sender', 'sender_id', 'classification', 'source_url', 'received_at', 'strategy', 'bytes_read', 'pages_sampled', 'metadata_message_id', 'category_id'];
  const fields = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!fields.length) return;
  const db = await getDb();
  const values = fields.map((field) => (patch as any)[field] ?? null);
  db.execute(`UPDATE pdf_records SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
}

export async function listRecords(categoryId?: string | null): Promise<PdfRecord[]> {
  const db = await getDb();
  const result = categoryId
    ? db.execute('SELECT * FROM pdf_records WHERE category_id = ? ORDER BY received_at DESC', [categoryId])
    : db.execute('SELECT * FROM pdf_records ORDER BY received_at DESC');
  return result.rows as PdfRecord[];
}

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  return db.execute('SELECT * FROM categories ORDER BY parent_id IS NOT NULL, sort_order ASC, name COLLATE NOCASE ASC').rows as Category[];
}

export async function createCategory(name: string, parentId: string | null = null): Promise<Category> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Category name is required');
  const db = await getDb();
  const id = `cat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const max = db.execute('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM categories WHERE parent_id IS ?', [parentId]).rows[0] as { max_order?: number };
  db.execute('INSERT INTO categories (id, name, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, cleanName, parentId, Number(max?.max_order ?? -1) + 1, now, now]);
  return (db.execute('SELECT * FROM categories WHERE id = ?', [id]).rows[0] as Category);
}

function ensureNoCategoryCycle(categories: Category[], id: string, parentId: string | null): void {
  if (!parentId) return;
  if (id === parentId) throw new Error('A category cannot contain itself');
  const byId = new Map(categories.map((category) => [category.id, category]));
  let cursor: string | null = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) throw new Error('Category hierarchy is cyclic');
    visited.add(cursor);
    if (cursor === id) throw new Error('A category cannot be moved inside its own descendant');
    cursor = byId.get(cursor)?.parent_id || null;
  }
}

export async function moveCategory(id: string, parentId: string | null): Promise<void> {
  const db = await getDb();
  const categories = await listCategories();
  const current = categories.find((category) => category.id === id);
  if (!current) throw new Error('Category not found');
  if (parentId && !categories.some((category) => category.id === parentId)) throw new Error('Parent category not found');
  ensureNoCategoryCycle(categories, id, parentId);
  const now = new Date().toISOString();
  db.execute('UPDATE categories SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, now, id]);
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Category name is required');
  const db = await getDb();
  db.execute('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?', [cleanName, new Date().toISOString(), id]);
}

export async function deleteCategory(id: string): Promise<void> {
  const db = await getDb();
  const category = db.execute('SELECT parent_id FROM categories WHERE id = ?', [id]).rows[0] as { parent_id?: string | null } | undefined;
  if (!category) throw new Error('Category not found');
  db.execute('UPDATE pdf_records SET category_id = NULL WHERE category_id = ?', [id]);
  db.execute('UPDATE categories SET parent_id = ?, updated_at = ? WHERE parent_id = ?', [category.parent_id || null, new Date().toISOString(), id]);
  db.execute('DELETE FROM categories WHERE id = ?', [id]);
}

export async function assignRecordCategory(recordId: string, categoryId: string | null): Promise<void> {
  const db = await getDb();
  if (categoryId && !db.execute('SELECT id FROM categories WHERE id = ?', [categoryId]).rows.length) throw new Error('Category not found');
  db.execute('UPDATE pdf_records SET category_id = ? WHERE id = ?', [categoryId, recordId]);
}

function cell(value: unknown): string {
  return String(value ?? '').replace(/[|\n\r]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function recordsToMarkdown(records: PdfRecord[]): string {
  const rows = records.map((record) => `| ${cell(record.title)} | ${cell(record.sender)} | **${cell(record.classification)}** | [Open PDF](${record.source_url}) | ${cell(record.received_at)} | ${cell(record.strategy || '')} |`);
  return ['# PDF Dashboard', '', '| Title | Sender | Type | Telegram source | Received | Strategy |', '|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.push().catch((error) => console.error('Paradox-DB final push failed', error));
  db.close();
  dbPromise = undefined;
}
