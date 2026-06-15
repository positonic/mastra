#!/usr/bin/env node
/**
 * List the WhatsApp GROUPS your linked account currently belongs to, by asking
 * the *running* gateway (it calls Baileys' groupFetchAllParticipating on the
 * live socket). This is the authoritative source for a group's JID — unlike the
 * whatsapp_messages.chats table, which only holds groups that arrived via the
 * partial history sync.
 *
 * Requires the gateway to be running the code that exposes
 * `GET /sessions/{sessionId}/groups` (deploy it first).
 *
 * IMPORTANT: never run a second Baileys socket against the same credentials —
 * this script does NOT do that. It only makes read-only HTTP calls to the
 * already-running gateway.
 *
 * Usage:
 *   AUTH_SECRET='<same secret both sides use>' \
 *   WHATSAPP_GATEWAY_URL='https://<your-gateway-host>' \
 *   USER_ID='<your exponential user id>' \
 *   node scripts/list-whatsapp-groups-live.mjs
 *
 *   # optional: filter by name
 *   ... node scripts/list-whatsapp-groups-live.mjs --search ops
 */

import jwt from 'jsonwebtoken';

const args = process.argv.slice(2);
const searchIdx = args.indexOf('--search');
const search = (searchIdx !== -1 ? args[searchIdx + 1] : null)?.toLowerCase() ?? null;

const AUTH_SECRET = process.env.AUTH_SECRET;
const GATEWAY_URL = (process.env.WHATSAPP_GATEWAY_URL || '').replace(/\/$/, '');
const USER_ID = process.env.USER_ID;

const missing = [
  !AUTH_SECRET && 'AUTH_SECRET',
  !GATEWAY_URL && 'WHATSAPP_GATEWAY_URL',
  !USER_ID && 'USER_ID',
].filter(Boolean);
if (missing.length) {
  console.error(`❌ Missing env var(s): ${missing.join(', ')}`);
  console.error('   See the header of this file for usage.');
  process.exit(1);
}

// Mint a short-lived whatsapp-gateway token, matching the app's claims
// (audience 'whatsapp-gateway', issuer 'todo-app', userId in payload).
const now = Math.floor(Date.now() / 1000);
const token = jwt.sign(
  {
    userId: USER_ID,
    sub: USER_ID,
    aud: 'whatsapp-gateway',
    iss: 'todo-app',
    iat: now,
    exp: now + 600, // 10 minutes
    tokenType: 'whatsapp-gateway',
  },
  AUTH_SECRET,
);

const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function getJson(path) {
  const res = await fetch(`${GATEWAY_URL}${path}`, { headers: authHeaders });
  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

try {
  // 1) Discover this user's sessions and pick a connected one.
  const { sessions } = await getJson('/sessions');
  if (!sessions || sessions.length === 0) {
    console.error('❌ No WhatsApp sessions for this user. Is the account linked, and is USER_ID correct?');
    process.exit(2);
  }
  const connected = sessions.find(s => s.connected) ?? sessions[0];
  if (!connected.connected) {
    console.error(`❌ Session ${connected.sessionId} is not connected to WhatsApp right now.`);
    process.exit(3);
  }
  console.log(`Using session ${connected.sessionId} (${connected.phoneNumber ?? 'unknown number'})\n`);

  // 2) Ask the live socket for all participating groups.
  const { groups } = await getJson(`/sessions/${connected.sessionId}/groups`);
  const filtered = search
    ? groups.filter(g => g.subject.toLowerCase().includes(search) || g.jid.toLowerCase().includes(search))
    : groups;

  if (filtered.length === 0) {
    console.log(search ? `No groups matching "${search}".` : 'No groups found.');
    process.exit(0);
  }

  console.log(`Found ${filtered.length} group(s)${search ? ` matching "${search}"` : ''}:\n`);
  for (const g of filtered) {
    console.log(`${g.subject}`);
    console.log(`   jid:          ${g.jid}`);
    console.log(`   participants: ${g.participants}`);
    console.log('');
  }
} catch (err) {
  console.error('❌ Failed:', err.message);
  if (String(err.message).includes('404')) {
    console.error('   The /groups route is missing — deploy the updated gateway first.');
  }
  process.exit(1);
}
