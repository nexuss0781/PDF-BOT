import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  assignRecordCategory,
  createCategory,
  deleteCategory,
  listCategories,
  listRecords,
  moveCategory,
  renameCategory,
} from './store.js';

function bodyOf(req: VercelRequest): Record<string, unknown> {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) as Record<string, unknown>; } catch { return {}; }
  }
  return (req.body || {}) as Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET') {
    try {
      return res.status(200).json({ ok: true, categories: await listCategories(), records: await listRecords() });
    } catch (error) {
      console.error('Dashboard read failed:', error);
      return res.status(500).json({ ok: false, error: 'Dashboard data could not be loaded' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const body = bodyOf(req);
  const action = String(body.action || '');
  try {
    if (action === 'create-category') {
      const category = await createCategory(String(body.name || ''), body.parentId ? String(body.parentId) : null);
      return res.status(201).json({ ok: true, category });
    }
    if (action === 'move-category') {
      await moveCategory(String(body.id || ''), body.parentId ? String(body.parentId) : null);
      return res.status(200).json({ ok: true });
    }
    if (action === 'rename-category') {
      await renameCategory(String(body.id || ''), String(body.name || ''));
      return res.status(200).json({ ok: true });
    }
    if (action === 'delete-category') {
      await deleteCategory(String(body.id || ''));
      return res.status(200).json({ ok: true });
    }
    if (action === 'assign-record') {
      await assignRecordCategory(String(body.recordId || ''), body.categoryId ? String(body.categoryId) : null);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown dashboard action' });
  } catch (error) {
    console.error('Dashboard mutation failed:', error);
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Dashboard update failed' });
  }
}
