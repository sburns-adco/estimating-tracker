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
 
/* Project JSON blobs live at the container root, named "<project #> - <project name>.json".
   Each carries its permanent internal id in blob metadata (projectid), so renaming a
   project just moves the blob — nothing else breaks.
   Power BI CSVs live under powerbi/ and are regenerated on every save/delete. */
function isProjectBlob(name) {
  return name.endsWith('.json') && !name.includes('/');
}
 
function safePart(s) {
  s = String(s || '').replace(/[^\w #&().\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 80).replace(/[. ]+$/, '');
}
 
function blobNameFor(project, id) {
  const num = safePart(project.num);
  const name = safePart(project.name);
  const base = num ? (name ? `${num} - ${name}` : num) : (name || id);
  return (base || id) + '.json';
}
 
/* Find a project's blob by its internal id (metadata match), falling back to the
   legacy "<id>.json" naming for blobs created before this version. */
async function findProjectBlob(container, id) {
  for await (const blob of container.listBlobsFlat({ includeMetadata: true })) {
    if (!isProjectBlob(blob.name)) continue;
    const metaId = blob.metadata && (blob.metadata.projectid || blob.metadata.Projectid);
    if (metaId === id || (!metaId && blob.name === id + '.json')) {
      return { name: blob.name, etag: blob.properties.etag };
    }
  }
  return null;
}
 
async function loadAllProjects(container, ctx) {
  const out = [];
  for await (const blob of container.listBlobsFlat({ includeMetadata: true })) {
    if (!isProjectBlob(blob.name)) continue;
    const metaId = blob.metadata && (blob.metadata.projectid || blob.metadata.Projectid);
    const id = metaId || blob.name.slice(0, -5);
    try {
      const dl = await container.getBlockBlobClient(blob.name).download();
      const text = await bodyToString(dl.readableStreamBody);
      out.push({ id, etag: dl.etag, data: JSON.parse(text) });
    } catch (e) {
      if (ctx) ctx.warn(`Skipping unreadable blob ${blob.name}: ${e.message}`);
    }
  }
  return out;
}
 
/* ---------- Power BI CSV export ---------- */
function csvEscape(v) {
  v = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return '﻿' + lines.join('\r\n');
}
 
async function rebuildPowerBi(container, ctx) {
  const projects = await loadAllProjects(container, ctx);
  const P = [], T = [], Q = [], M = [], B = [], C = [], R = [], S = [];
  for (const { id, data: p } of projects) {
    const base = { project_id: id, project_num: p.num || id, project_name: p.name || '' };
    P.push({
      ...base,
      created: p.created || '',
      takeoff_items: (p.takeoff || []).length,
      takeoff_in_conest: (p.takeoff || []).filter((r) => r.conest).length,
      quotes_required: (p.quotes || []).filter((q) => q.req).length,
      quotes_sent: (p.quotes || []).filter((q) => q.req && q.sent).length,
      rfis_total: (p.rfis || []).length,
      rfis_open: (p.rfis || []).filter((r) => !r.answered).length,
      scope_qualifications: (p.scope || []).length,
      overview_notes: p.overviewNotes || '',
    });
    (p.takeoff || []).forEach((r) => T.push({ ...base, category: r.cat, item: r.item, estimator: r.estimator, in_conest: r.conest ? 1 : 0, time_started: r.start, time_completed: r.done, notes: r.notes, is_custom: r.custom ? 1 : 0 }));
    (p.quotes || []).forEach((q) => Q.push({ ...base, item: q.item, required: q.req ? 1 : 0, sent: q.sent ? 1 : 0, vendors: q.vendors }));
    (p.matspec || []).forEach((sec) => (sec.fields || []).forEach((f) => M.push({ ...base, section: sec.cat, spec_item: f.lab, value: f.val })));
    (p.bidform || []).forEach((b) => B.push({ ...base, topic: b.t, question: b.q, answer: b.ans }));
    (p.conestItems || []).forEach((c, i) => C.push({ ...base, item_no: i + 1, item: c.txt, done: c.done ? 1 : 0 }));
    (p.rfis || []).forEach((r, i) => R.push({ ...base, rfi_no: i + 1, question: r.q, date_sent: r.dateSent, answered: r.answered ? 1 : 0, answer: r.a }));
    (p.scope || []).forEach((s, i) => S.push({ ...base, qual_no: i + 1, qualification: s.txt }));
  }
  const baseCols = ['project_id', 'project_num', 'project_name'];
  const files = {
    'powerbi/projects.csv': toCsv(P, [...baseCols, 'created', 'takeoff_items', 'takeoff_in_conest', 'quotes_required', 'quotes_sent', 'rfis_total', 'rfis_open', 'scope_qualifications', 'overview_notes']),
    'powerbi/takeoff.csv': toCsv(T, [...baseCols, 'category', 'item', 'estimator', 'in_conest', 'time_started', 'time_completed', 'notes', 'is_custom']),
    'powerbi/quotes.csv': toCsv(Q, [...baseCols, 'item', 'required', 'sent', 'vendors']),
    'powerbi/material_spec.csv': toCsv(M, [...baseCols, 'section', 'spec_item', 'value']),
    'powerbi/bid_form.csv': toCsv(B, [...baseCols, 'topic', 'question', 'answer']),
    'powerbi/conest_items.csv': toCsv(C, [...baseCols, 'item_no', 'item', 'done']),
    'powerbi/rfis.csv': toCsv(R, [...baseCols, 'rfi_no', 'question', 'date_sent', 'answered', 'answer']),
    'powerbi/scope.csv': toCsv(S, [...baseCols, 'qual_no', 'qualification']),
  };
  for (const [name, text] of Object.entries(files)) {
    await container.getBlockBlobClient(name).upload(text, Buffer.byteLength(text), {
      blobHTTPHeaders: { blobContentType: 'text/csv; charset=utf-8' },
    });
  }
}
 
async function tryRebuildPowerBi(container, ctx) {
  try {
    await rebuildPowerBi(container, ctx);
  } catch (e) {
    ctx.error(`Power BI CSV rebuild failed (project save still succeeded): ${e.message}`);
  }
}
 
/* GET /api/projects — list all projects with their ETags */
app.http('projectsList', {
  methods: ['GET'],
  route: 'projects',
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    try {
      const container = containerClient();
      await container.createIfNotExists();
      const all = await loadAllProjects(container, ctx);
      return json(200, all);
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
      const existing = await findProjectBlob(container, id);
 
      if (req.method === 'GET') {
        if (!existing) return json(404, { error: 'Not found' });
        const dl = await container.getBlockBlobClient(existing.name).download();
        const text = await bodyToString(dl.readableStreamBody);
        return json(200, { id, etag: dl.etag, data: JSON.parse(text) });
      }
 
      if (req.method === 'PUT') {
        const text = await req.text();
        if (!text || text.length > 4_000_000) return json(400, { error: 'Body missing or too large.' });
        let parsed;
        try { parsed = JSON.parse(text); } catch { return json(400, { error: 'Body is not valid JSON.' }); }
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'Body must be a JSON object.' });
 
        const ifMatch = req.headers.get('if-match');
        const target = blobNameFor(parsed, id);
        const uploadOpts = {
          metadata: { projectid: id },
          blobHTTPHeaders: { blobContentType: 'application/json' },
        };
 
        if (existing) {
          // Version check against the blob the client loaded
          if (!ifMatch || ifMatch !== existing.etag) {
            return json(409, { error: 'Conflict: the project was modified by someone else.' });
          }
          if (existing.name === target) {
            const res = await container.getBlockBlobClient(target)
              .upload(text, Buffer.byteLength(text), { ...uploadOpts, conditions: { ifMatch } });
            await tryRebuildPowerBi(container, ctx);
            return json(200, { id, etag: res.etag });
          }
          // Project # / name changed → write under the new name, then remove the old blob
          let res;
          try {
            res = await container.getBlockBlobClient(target)
              .upload(text, Buffer.byteLength(text), { ...uploadOpts, conditions: { ifNoneMatch: '*' } });
          } catch (e) {
            if (e.statusCode === 409 || e.statusCode === 412) {
              return json(409, { error: `A project file named "${target}" already exists. Use a different project # / name.` });
            }
            throw e;
          }
          await container.getBlockBlobClient(existing.name).deleteIfExists();
          await tryRebuildPowerBi(container, ctx);
          return json(200, { id, etag: res.etag });
        }
 
        // New project
        if (ifMatch) return json(409, { error: 'Conflict: the project no longer exists (deleted by someone else).' });
        let res;
        try {
          res = await container.getBlockBlobClient(target)
            .upload(text, Buffer.byteLength(text), { ...uploadOpts, conditions: { ifNoneMatch: '*' } });
        } catch (e) {
          if (e.statusCode === 409 || e.statusCode === 412) {
            return json(409, { error: `A project file named "${target}" already exists. Use a different project # / name.` });
          }
          throw e;
        }
        await tryRebuildPowerBi(container, ctx);
        return json(200, { id, etag: res.etag });
      }
 
      if (req.method === 'DELETE') {
        if (existing) await container.getBlockBlobClient(existing.name).deleteIfExists();
        await tryRebuildPowerBi(container, ctx);
        return json(200, { ok: true });
      }
 
      return json(405, { error: 'Method not allowed' });
    } catch (e) {
      ctx.error(e);
      return json(500, { error: e.message });
    }
  },
});