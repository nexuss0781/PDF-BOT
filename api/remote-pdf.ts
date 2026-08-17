import type { TelegramDocument } from './types.js';

export type RemoteClassification = {
  type: 'Selectable' | 'Scanned' | 'Needs inspection';
  strategy: 'remote-full-under-30mb' | 'remote-range-sampled' | 'remote-bounded-full' | 'failed';
  bytesRead: number;
  pagesSampled: number;
  reason: string;
};

const SAMPLE_PAGES = 3;
const TEXT_THRESHOLD = 40;
const SMALL_LIMIT = 30 * 1024 * 1024;
const FILE_BASE = (process.env.TELEGRAM_FILE_BASE_URL || 'https://telegram-bot-api-gl9q.onrender.com/file').replace(/\/$/, '');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function fileUrl(filePath: string): string {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
  return `${FILE_BASE}/bot${BOT_TOKEN}/${filePath.replace(/^\/+/, '')}`;
}

async function fetchRange(url: string, begin: number, endExclusive: number): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${begin}-${endExclusive - 1}` } });
      if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
      if (response.status === 200 && begin === 0) return new Uint8Array(await response.arrayBuffer());
      throw new Error(`Remote file range unsupported: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, [2000, 5000, 10000][attempt]));
    }
  }
  throw new Error('Remote range request failed');
}

async function discoverSize(url: string, document: TelegramDocument): Promise<number> {
  if (document.file_size) return document.file_size;
  const response = await fetch(url, { method: 'HEAD' });
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) return length;
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const match = probe.headers.get('content-range')?.match(/\/([0-9]+)$/);
  if (match) return Number(match[1]);
  throw new Error('Remote file size is unavailable');
}

async function pdfjs() { return await import('pdfjs-dist/legacy/build/pdf.mjs') as any; }

async function classifyPdf(pdf: any, strategy: RemoteClassification['strategy'], bytesRead: number, reason: string): Promise<RemoteClassification> {
  let text = '';
  const pages = Math.min(SAMPLE_PAGES, pdf.numPages);
  for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    text += content.items.map((item: any) => item.str || '').join(' ');
    if (text.replace(/\s+/g, ' ').trim().length >= TEXT_THRESHOLD) break;
  }
  await pdf.destroy();
  return {
    type: text.replace(/\s+/g, ' ').trim().length >= TEXT_THRESHOLD ? 'Selectable' : 'Scanned',
    strategy,
    bytesRead,
    pagesSampled: pages,
    reason,
  };
}

class RemoteRangeTransport {
  readonly length: number;
  bytesRead = 0;
  private readonly url: string;
  private listeners = new Map<number, Array<(chunk: Uint8Array) => void>>();

  constructor(url: string, length: number) { this.url = url; this.length = length; }
  addRangeListener(begin: number, listener: (chunk: Uint8Array) => void) {
    this.listeners.set(begin, [...(this.listeners.get(begin) || []), listener]);
  }
  addProgressiveReadListener() {}
  addProgressiveDoneListener() {}
  onDataProgress() {}
  onDataProgressiveRead() {}
  transportReady() {}
  async requestDataRange(begin: number, end: number) {
    const chunk = await fetchRange(this.url, begin, end);
    this.bytesRead += chunk.byteLength;
    for (const listener of this.listeners.get(begin) || []) listener(chunk);
    this.listeners.delete(begin);
  }
}

export async function classifyRemotePdf(document: TelegramDocument, filePath: string): Promise<RemoteClassification> {
  const url = fileUrl(filePath);
  const size = await discoverSize(url, document);
  try {
    const { getDocument, PDFDataRangeTransport } = await pdfjs();

    if (size <= SMALL_LIMIT) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Remote PDF download failed: HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      const pdf = await getDocument({ data, stopAtErrors: false }).promise;
      return await classifyPdf(pdf, 'remote-full-under-30mb', data.byteLength, 'Fetched the complete PDF because it is under the 30 MB inspection threshold.');
    }

    const source = new RemoteRangeTransport(url, size);
    const transport = new PDFDataRangeTransport(size, null, false);
    (transport as any).requestDataRange = (begin: number, end: number) => source.requestDataRange(begin, end);
    (transport as any).addRangeListener = (begin: number, listener: (chunk: Uint8Array) => void) => source.addRangeListener(begin, listener);
    const pdf = await getDocument({ range: transport, length: size, disableAutoFetch: true, disableStream: true, stopAtErrors: false }).promise;
    return await classifyPdf(pdf, 'remote-range-sampled', source.bytesRead, 'Used PDF.js byte-range inspection without downloading the full PDF.');
  } catch (error) {
    console.error('Remote PDF classification error:', error);
    return { type: 'Needs inspection', strategy: 'failed', bytesRead: 0, pagesSampled: 0, reason: String(error).slice(0, 240) };
  }
}
