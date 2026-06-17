#!/usr/bin/env node
/**
 * One-time: create the Notion database that captured HSS WhatsApp messages
 * sync into. Uses NOTION_CAPTURE_TOKEN (the dedicated internal integration)
 * so that same token can later append rows.
 *
 * The integration MUST be connected to the parent page first
 * (page → ••• → Connections → add the integration), or Notion returns
 * "Could not find page" / unauthorized.
 *
 * Usage:
 *   cd /Users/james/code/mastra && node scripts/create-hss-notion-db.mjs
 *
 * Reads NOTION_CAPTURE_TOKEN from .env (or the environment).
 * Prints the new database id — save it as NOTION_CAPTURE_DATABASE_ID.
 */

import fs from 'node:fs';
import path from 'node:path';

const NOTION_VERSION = '2022-06-28';
const PARENT_PAGE_ID = '38050438-95cf-800b-8805-c54fb818b054'; // HSS DAO - Senior staff update

// Resolve the token from env, falling back to parsing .env (avoids --env-file quirks).
function resolveToken() {
  if (process.env.NOTION_CAPTURE_TOKEN) return process.env.NOTION_CAPTURE_TOKEN.trim();
  try {
    const envPath = path.join(process.cwd(), '.env');
    const line = fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .find(l => l.startsWith('NOTION_CAPTURE_TOKEN='));
    if (line) return line.slice('NOTION_CAPTURE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  } catch {
    /* ignore */
  }
  return null;
}

const token = resolveToken();
if (!token) {
  console.error('❌ NOTION_CAPTURE_TOKEN not found (env or .env). Add it and retry.');
  process.exit(1);
}

const res = await fetch('https://api.notion.com/v1/databases', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
    title: [{ type: 'text', text: { content: 'HSS DAO — WhatsApp Capture' } }],
    properties: {
      // Title column — keep the message text as the row's primary content.
      Message: { title: {} },
      Sender: { rich_text: {} },
      Date: { date: {} },
      Direction: {
        select: {
          options: [
            { name: 'incoming', color: 'blue' },
            { name: 'outgoing', color: 'green' },
          ],
        },
      },
      // Stable WhatsApp message id — used to dedupe so re-syncs don't double-write.
      MessageID: { rich_text: {} },
    },
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error(`❌ Notion API ${res.status}:`, JSON.stringify(body, null, 2));
  if (body?.code === 'object_not_found') {
    console.error('\n👉 The integration is not connected to the parent page.');
    console.error('   In Notion: open the page → ••• → Connections → add your integration, then retry.');
  }
  process.exit(1);
}

console.log('✅ Database created.\n');
console.log(`   id:    ${body.id}`);
console.log(`   url:   ${body.url}`);
console.log('\nNext: save this as NOTION_CAPTURE_DATABASE_ID (mastra .env + Railway mastra service).');
