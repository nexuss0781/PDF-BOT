import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listPendingSync, updateSyncState } from './store.js';

const SYNC_SECRET = process.env.MY_COMPUTER_SYNC_SECRET;

function authorized(req: VercelRequest): boolean {
  return Boolean(SYNC_SECRET && req.headers['x-my-computer-sync-secret'] === SYNC_SECRET);
}

function jsonError(res: VercelResponse, status: number, error: string) {
  return res.status(status).json({ ok: false, error });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!SYNC_SECRET) return jsonError(res, 503, 'My-Computer sync secret is not configured');
  if (!authorized(req)) return jsonError(res, 401, 'Unauthorized');

  try {
    if (req.method === 'GET') {
      const requestedLimit = Number(req.query.limit || 100);
      const records = await listPendingSync(requestedLimit);
      return res.status(200).json({
        ok: true,
        records: records.map((record) => ({
          id: record.id,
          title: record.title,
          classification: record.classification,
          category_id: record.category_id || null,
          source_file_id: record.source_file_id,
          source_chat_id: record.source_chat_id,
          source_message_id: record.source_message_id,
          sender: record.sender,
          received_at: record.received_at,
          sync_status: record.sync_status || 'pending',
          sha256: record.sha256 || null,
        })),
      });
    }

    if (req.method === 'POST') {
      const body = req.body as { action?: string; id?: string; sync_status?: string; hf_path?: string; hf_url?: string; sha256?: string; sync_error?: string; sync_job_id?: string };
      if (!body.id) return jsonError(res, 400, 'Missing record id');
      const allowed = new Set(['pending', 'queued', 'uploading', 'synced', 'retry_wait', 'failed']);
      if (!body.sync_status || !allowed.has(body.sync_status)) return jsonError(res, 400, 'Invalid sync status');
      await updateSyncState(body.id, {
        sync_status: body.sync_status as 'pending' | 'queued' | 'uploading' | 'synced' | 'retry_wait' | 'failed',
        hf_path: body.hf_path || null,
        hf_url: body.hf_url || null,
        sha256: body.sha256 || null,
        sync_error: body.sync_error || null,
        sync_job_id: body.sync_job_id || null,
      });
      return res.status(200).json({ ok: true, action: body.action || 'update', id: body.id });
    }

    return jsonError(res, 405, 'Method not allowed');
  } catch (error) {
    console.error('My-Computer sync API failed:', error);
    return jsonError(res, 500, 'Internal server error');
  }
}
