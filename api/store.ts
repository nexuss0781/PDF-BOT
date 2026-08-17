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
    metadata_message_id INTEGER NOT NULL
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
};

export async function savePending(record: PdfRecord): Promise<void> {
  const db = await getDb();
  db.execute(`INSERT INTO pdf_records (id, title, sender, sender_id, classification, source_url, received_at, strategy, bytes_read, pages_sampled, metadata_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, sender=excluded.sender, sender_id=excluded.sender_id,
      classification=excluded.classification, source_url=excluded.source_url, received_at=excluded.received_at,
      strategy=excluded.strategy, bytes_read=excluded.bytes_read, pages_sampled=excluded.pages_sampled,
      metadata_message_id=excluded.metadata_message_id`, [record.id, record.title, record.sender, record.sender_id, record.classification, record.source_url, record.received_at, record.strategy || null, record.bytes_read || 0, record.pages_sampled || 0, record.metadata_message_id]);
}

export async function updateRecord(id: string, patch: Partial<PdfRecord>): Promise<void> {
  const allowed = ['title', 'sender', 'sender_id', 'classification', 'source_url', 'received_at', 'strategy', 'bytes_read', 'pages_sampled', 'metadata_message_id'];
  const fields = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!fields.length) return;
  const db = await getDb();
  const values = fields.map((field) => (patch as any)[field] ?? null);
  db.execute(`UPDATE pdf_records SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
}

export async function listRecords(classification?: PdfRecord['classification']): Promise<PdfRecord[]> {
  const db = await getDb();
  const result = classification
    ? db.execute('SELECT * FROM pdf_records WHERE classification = ? ORDER BY received_at DESC', [classification])
    : db.execute('SELECT * FROM pdf_records ORDER BY received_at DESC');
  return result.rows as PdfRecord[];
}

function cell(value: unknown): string {
  return String(value ?? '').replace(/[|\n\r]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function recordsToMarkdown(records: PdfRecord[]): string {
  const rows = records.map((record) => `| ${cell(record.title)} | ${cell(record.sender)} | **${cell(record.classification)}** | [Open PDF](${record.source_url}) | ${cell(record.received_at)} | ${cell(record.strategy || '')} |`);
  return [
    '# PDF Dashboard',
    '',
    '| Title | Sender | Type | Telegram source | Received | Strategy |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.push().catch((error) => console.error('Paradox-DB final push failed', error));
  db.close();
  dbPromise = undefined;
}
