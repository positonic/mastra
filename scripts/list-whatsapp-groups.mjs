#!/usr/bin/env node
/**
 * List WhatsApp chats captured in the mastra store, so you can find a group's JID.
 *
 * Reads from the `whatsapp_messages` schema (see src/mastra/bots/whatsapp-store.ts).
 *
 * Usage:
 *   DATABASE_URL='<railway-postgres-url>' node scripts/list-whatsapp-groups.mjs
 *   DATABASE_URL='...' node scripts/list-whatsapp-groups.mjs --all          # include 1:1 chats too
 *   DATABASE_URL='...' node scripts/list-whatsapp-groups.mjs --search ops   # filter by name (case-insensitive)
 *
 * NOTE: use the *Railway* DATABASE_URL (the prod mastra DB), not mastra/.env —
 * the committed .env is a stale copy and will give false negatives.
 */

import pg from 'pg';

const args = process.argv.slice(2);
const includeAll = args.includes('--all');
const forceSsl = args.includes('--ssl');
const searchIdx = args.indexOf('--search');
const search = searchIdx !== -1 ? args[searchIdx + 1] : null;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Pass the Railway mastra Postgres URL, e.g.:');
  console.error("   DATABASE_URL='postgres://...' node scripts/list-whatsapp-groups.mjs");
  process.exit(1);
}

// SSL is OFF by default (many Railway/internal connections reject SSL).
// Enable it only when the URL asks for it (sslmode=require) or you pass --ssl.
const wantSsl = forceSsl || /sslmode=(require|verify)/.test(connectionString);
const pool = new pg.Pool({
  connectionString,
  ssl: wantSsl ? { rejectUnauthorized: false } : false,
});

try {
  // Does the schema/table exist yet?
  const { rows: exists } = await pool.query(`
    SELECT to_regclass('whatsapp_messages.chats') IS NOT NULL AS present
  `);
  if (!exists[0]?.present) {
    console.error('❌ whatsapp_messages.chats does not exist on this database.');
    console.error('   Either the gateway has never run against this DB, or DATABASE_URL points at the wrong (stale) DB.');
    process.exit(2);
  }

  const where = [];
  const params = [];
  if (!includeAll) where.push('is_group = true');
  if (search) {
    params.push(`%${search}%`);
    where.push(`(contact_name ILIKE $${params.length} OR push_name ILIKE $${params.length} OR jid ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `
    SELECT
      c.jid,
      COALESCE(c.contact_name, c.push_name) AS name,
      c.is_group,
      c.message_count,
      c.last_message_at,
      (SELECT COUNT(*) FROM whatsapp_messages.messages m WHERE m.chat_id = c.id) AS stored_messages
    FROM whatsapp_messages.chats c
    ${whereSql}
    ORDER BY c.last_message_at DESC NULLS LAST
    `,
    params,
  );

  if (rows.length === 0) {
    console.log(includeAll ? 'No chats found.' : 'No groups found. (Try --all to list every chat.)');
    process.exit(0);
  }

  console.log(`\nFound ${rows.length} ${includeAll ? 'chat(s)' : 'group(s)'}:\n`);
  for (const r of rows) {
    const kind = r.is_group ? 'GROUP' : '1:1  ';
    const last = r.last_message_at ? new Date(r.last_message_at).toISOString().slice(0, 16).replace('T', ' ') : '—';
    console.log(`[${kind}] ${r.name ?? '(no name)'}`);
    console.log(`         jid:    ${r.jid}`);
    console.log(`         stored: ${r.stored_messages} messages   last: ${last}`);
    console.log('');
  }
} catch (err) {
  console.error('❌ Query failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
