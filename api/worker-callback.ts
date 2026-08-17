import type { VercelRequest, VercelResponse } from '@vercel/node';
import { workerCallbackHandler } from './webhook.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return workerCallbackHandler(req, res);
}
