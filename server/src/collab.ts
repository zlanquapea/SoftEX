import { createHash } from 'node:crypto';
import { Router } from 'express';
import * as Y from 'yjs';
import { z } from 'zod';
import { canEditBoard, canEditPage, canViewBoard, canViewPage, type Auth } from './access.js';
import { authOf, type Ctx } from './context.js';
import type { Database, Row } from './db.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse } from './util.js';

/**
 * Live collaboration on knowledge pages and whiteboards, built on Yjs (a CRDT).
 *
 * Every edit is a small Yjs update. Updates are appended to `collab_updates` and relayed to
 * everyone who can open the document; Yjs merges them in any order, so several people can type
 * at once without conflicts, and several Küü servers can accept edits without coordinating.
 * On read the updates are merged; when a document has many rows they are compacted into one.
 */

export type DocKind = 'page' | 'board';
export const docKey = (kind: DocKind, id: string) => `${kind}:${id}`;

const MAX_UPDATE_BYTES = 512 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const COMPACT_AFTER = 64;

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/**
 * The starting state of a page's shared text. Its Yjs client id comes from the text itself, so
 * two servers that set a page up at the same moment produce the very same update (merging them
 * does not duplicate the text), while a restart from different text never reuses old item ids.
 */
function initialPageUpdate(title: string, body: string) {
  const doc = new Y.Doc();
  doc.clientID = createHash('sha256').update(`${title}\u0000${body}`).digest().readUInt32BE(0) || 1;
  doc.transact(() => {
    doc.getText('title').insert(0, title);
    doc.getText('body').insert(0, body);
  });
  return Y.encodeStateAsUpdate(doc);
}

async function loadTarget(db: Database, auth: Auth, kind: DocKind, id: string) {
  if (kind === 'page') {
    const page = await db.get('SELECT * FROM pages WHERE id = ?', id);
    if (!page || !await canViewPage(db, auth, page)) throw notFound('Page');
    return { row: page, canEdit: !page.archived_at && await canEditPage(db, auth, page) };
  }
  const board = await db.get('SELECT * FROM boards WHERE id = ?', id);
  if (!board || !await canViewBoard(db, auth, board)) throw notFound('Whiteboard');
  return { row: board, canEdit: !board.archived_at && await canEditBoard(db, auth, board) };
}

/** May this person follow a document's live updates? (Used for realtime audiences.) */
export async function canViewDoc(db: Database, auth: Auth, key: string) {
  const [kind, id] = key.split(':');
  if (kind === 'page') {
    const page = await db.get('SELECT * FROM pages WHERE id = ?', id);
    return !!page && canViewPage(db, auth, page);
  }
  if (kind === 'board') {
    const board = await db.get('SELECT * FROM boards WHERE id = ?', id);
    return !!board && canViewBoard(db, auth, board);
  }
  return false;
}

/** The merged state of a document, creating a page's initial state on first use. */
export async function docState(db: Database, key: string, init?: () => Uint8Array) {
  let rows = await db.all('SELECT id, data FROM collab_updates WHERE doc_key = ? ORDER BY created_at, id', key);
  if (!rows.length && init) {
    await db.insert('collab_updates', { id: newId(), doc_key: key, data: toB64(init()), user_id: null, created_at: now() });
    rows = await db.all('SELECT id, data FROM collab_updates WHERE doc_key = ? ORDER BY created_at, id', key);
  }
  const merged = rows.length ? Y.mergeUpdates(rows.map((r) => fromB64(r.data))) : new Uint8Array([0, 0]);
  if (rows.length > COMPACT_AFTER) {
    // Replace exactly the rows we read with one merged row; updates written meanwhile are kept.
    await db.transaction(async () => {
      for (const r of rows) await db.run('DELETE FROM collab_updates WHERE id = ?', r.id);
      await db.insert('collab_updates', { id: newId(), doc_key: key, data: toB64(merged), user_id: null, created_at: now() });
    });
  }
  return merged;
}

export function docFrom(update: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

/** Page text as the live editors currently have it, or null when nobody has opened the editor. */
export async function livePageText(db: Database, pageId: string) {
  const key = docKey('page', pageId);
  const exists = await db.get('SELECT 1 FROM collab_updates WHERE doc_key = ? LIMIT 1', key);
  if (!exists) return null;
  const doc = docFrom(await docState(db, key));
  return { title: doc.getText('title').toString(), body: doc.getText('body').toString() };
}

/**
 * After a page is saved some other way (the API, restoring a version), start the live draft
 * again from the saved text so editors don't keep typing into an outdated copy.
 */
export async function resetPageIfDiverged(ctx: Ctx, workspaceId: string, page: Row) {
  const live = await livePageText(ctx.db, page.id);
  if (!live || (live.title === page.title && live.body === page.body)) return;
  const key = docKey('page', page.id);
  await ctx.db.run('DELETE FROM collab_updates WHERE doc_key = ?', key);
  await ctx.hub.publish(workspaceId, { type: 'collab.reset', key }, { kind: 'doc', key });
}

export async function dropDoc(db: Database, key: string) {
  await db.run('DELETE FROM collab_updates WHERE doc_key = ?', key);
}

const Kind = z.enum(['page', 'board']);
const B64 = z.string().max(Math.ceil((MAX_UPDATE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]*={0,2}$/);

export function collabRouter(ctx: Ctx, onBoardChange?: (auth: Auth, board: Row) => Promise<void>) {
  const r = Router();
  const { db } = ctx;

  /** Catch up: send the state vector you have, get back what you're missing. */
  r.post('/collab/:kind/:id/sync', async (req, res) => {
    const auth = authOf(req);
    const kind = parse(Kind, req.params.kind);
    const { row, canEdit } = await loadTarget(db, auth, kind, req.params.id);
    const { stateVector } = parse(z.object({ stateVector: B64.optional() }), req.body);
    const key = docKey(kind, row.id);
    const state = await docState(db, key, kind === 'page' ? () => initialPageUpdate(row.title, row.body) : undefined);
    let update: Uint8Array;
    try {
      update = stateVector ? Y.diffUpdate(state, fromB64(stateVector)) : state;
    } catch {
      throw badRequest('Invalid state vector');
    }
    res.json({ update: toB64(update), stateVector: toB64(Y.encodeStateVectorFromUpdate(state)), can_edit: canEdit });
  });

  /** Apply an edit and relay it to everyone else who has the document open. */
  r.post('/collab/:kind/:id/update', async (req, res) => {
    const auth = authOf(req);
    const kind = parse(Kind, req.params.kind);
    const { row, canEdit } = await loadTarget(db, auth, kind, req.params.id);
    if (!canEdit) throw forbidden('You can view this but not edit it');
    const { update, clientId } = parse(z.object({ update: B64, clientId: z.string().max(64).optional() }), req.body);
    const bytes = fromB64(update);
    if (bytes.length > MAX_UPDATE_BYTES) throw new HttpError(413, 'That change is too large');
    try {
      Y.decodeUpdate(bytes);
    } catch {
      throw badRequest('Invalid update');
    }
    const key = docKey(kind, row.id);
    const size = await db.get<{ n: number }>('SELECT SUM(LENGTH(data)) AS n FROM collab_updates WHERE doc_key = ?', key);
    if ((Number(size?.n) || 0) > (MAX_DOC_BYTES * 4) / 3) throw new HttpError(413, 'This document is too large to keep editing live');
    await db.insert('collab_updates', { id: newId(), doc_key: key, data: update, user_id: auth.userId, created_at: now() });
    await ctx.hub.publish(auth.workspaceId, { type: 'collab.update', key, update, clientId: clientId ?? null }, { kind: 'doc', key });
    if (kind === 'board') await onBoardChange?.(auth, row);
    res.json({ ok: true });
  });

  /** Who is here, and where their cursor is (not stored). */
  r.post('/collab/:kind/:id/presence', async (req, res) => {
    const auth = authOf(req);
    const kind = parse(Kind, req.params.kind);
    const { row } = await loadTarget(db, auth, kind, req.params.id);
    const body = parse(
      z.object({
        active: z.boolean(),
        clientId: z.string().max(64),
        cursor: z.object({ x: z.number().finite(), y: z.number().finite() }).nullish(),
        selection: z.object({ field: z.enum(['title', 'body']), start: z.number().int().min(0), end: z.number().int().min(0) }).nullish(),
      }),
      req.body,
    );
    const user = await db.get('SELECT id, name, color FROM users WHERE id = ?', auth.userId);
    await ctx.hub.publish(
      auth.workspaceId,
      { type: 'collab.presence', key: docKey(kind, row.id), user, clientId: body.clientId, active: body.active, cursor: body.cursor ?? null, selection: body.selection ?? null },
      { kind: 'doc', key: docKey(kind, row.id) },
    );
    res.json({ ok: true });
  });

  return r;
}
