'use strict';
const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = process.env.ESTIMATES_CONTAINER || 'estimates';
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function containerClient() {
  const cs = process.env.STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!cs) throw new Error('Missing app setting STORAGE_CONNECTION_STRING (storage account connection string).');
  return BlobServiceClient.fromConnectionString(cs).getContainerClient(CONTAINER);
}

async function bodyToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const json = (status, body, extra = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  body: JSON.stringify(body),
});

/* GET /api/projects — list all projects with their ETags */
app.http('projectsList', {
  methods: ['GET'],
  route: 'projects',
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    try {
      const container = containerClient();
      await container.createIfNotExists();
      const out = [];
      for await (const blob of container.listBlobsFlat()) {
        if (!blob.name.endsWith('.json')) continue;
        const id = blob.name.slice(0, -5);
        try {
          const dl = await container.getBlockBlobClient(blob.name).download();
          const text = await bodyToString(dl.readableStreamBody);
          out.push({ id, etag: dl.etag, data: JSON.parse(text) });
        } catch (e) {
          ctx.warn(`Skipping unreadable blob ${blob.name}: ${e.message}`);
        }
      }
      return json(200, out);
    } catch (e) {
      ctx.error(e);
      return json(500, { error: e.message });
    }
  },
});

/* GET/PUT/DELETE /api/projects/{id} */
app.http('projectItem', {
  methods: ['GET', 'PUT', 'DELETE'],
  route: 'projects/{id}',
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return json(400, { error: 'Invalid project id.' });
    try {
      const container = containerClient();
      await container.createIfNotExists();
      const blob = container.getBlockBlobClient(id + '.json');

      if (req.method === 'GET') {
        try {
          const dl = await blob.download();
          const text = await bodyToString(dl.readableStreamBody);
          return json(200, { id, etag: dl.etag, data: JSON.parse(text) });
        } catch (e) {
          if (e.statusCode === 404) return json(404, { error: 'Not found' });
          throw e;
        }
      }

      if (req.method === 'PUT') {
        const text = await req.text();
        if (!text || text.length > 4_000_000) return json(400, { error: 'Body missing or too large.' });
        let parsed;
        try { parsed = JSON.parse(text); } catch { return json(400, { error: 'Body is not valid JSON.' }); }
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'Body must be a JSON object.' });

        const ifMatch = req.headers.get('if-match');
        const conditions = ifMatch ? { ifMatch } : { ifNoneMatch: '*' };
        try {
          const res = await blob.upload(text, Buffer.byteLength(text), {
            conditions,
            blobHTTPHeaders: { blobContentType: 'application/json' },
          });
          return json(200, { id, etag: res.etag });
        } catch (e) {
          if (e.statusCode === 412 || e.statusCode === 409) {
            return json(409, { error: 'Conflict: the project was modified by someone else.' });
          }
          throw e;
        }
      }

      if (req.method === 'DELETE') {
        await blob.deleteIfExists();
        return json(200, { ok: true });
      }

      return json(405, { error: 'Method not allowed' });
    } catch (e) {
      ctx.error(e);
      return json(500, { error: e.message });
    }
  },
});