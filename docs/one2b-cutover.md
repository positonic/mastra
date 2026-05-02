# one2b-internal-agent → exponential cutover

This doc covers the transition from running one2b's automation as a separate
service (`one2b-internal-agent` against a Railway DB) to running it as a set
of agents inside the exponential mastra runtime against exponential's DB.

The cutover is **gated behind environment flags** so all code can land on
`main` in both repos without activating anything. Operators flip the flags
in a deliberate order during the cutover window.

## The flags

| Flag | Service | Default | Gates |
|---|---|---|---|
| `MASTRA_ONE2B_AGENTS_ENABLED` | mastra | unset (off) | Agent registration in the Mastra agents map. When off, the one2b agents are not in the agents object — not reachable via `/api/agents/*`, not addressable by routing, no risk of accidental invocation. |
| `EXPONENTIAL_ONE2B_WEBHOOKS_ENABLED` | exponential | unset (off) | Webhook handler processing for one2b sources (Fireflies, 360dialog, Monday). When off, handlers should return 200 OK to the provider but skip downstream processing. |
| `MASTRA_ONE2B_SCHEDULERS_ENABLED` | mastra | unset (off) | Cron jobs for pre-meeting briefs and action item reminders. When off, schedulers do not start. |

Each is checked with strict `=== 'true'` (any other value, including `'1'`
or unset, is off).

## Cutover sequence

Stops 4 → 6 must happen in this order. Stops 1 → 3 can happen any time
before that.

1. **Both PRs merge to main with all flags off.** Code is live but dormant.
   `one2b-internal-agent` continues running as the production processor.

2. **Provision the one2b workspace in exponential** if not already:
   - Workspace exists with `slug='one2b'`
   - All team members have `User` rows + `WorkspaceUser` membership
   - Bot service account user (`bot+one2b@exponential.app`, `isServiceAccount=true`)
   - `Integration` rows for Fireflies, Monday, 360dialog, Postmark, Google
     Drive — each with a generated `webhookId` and encrypted credentials

3. **Migrate data from Railway → exponential DB** (Phase 6 of the merge plan):
   - Meetings → `TranscriptionSession`
   - Participants → `TranscriptionSessionParticipant` (linked to `User` or
     `CrmContact` where possible)
   - Action items → `Action` with `sourceType='meeting'`,
     `sourceId=<transcriptionSessionId>`, plus `ActionAssignee` or
     `ActionParticipantAssignee` per the 3-tier resolution
   - Documents → `Document` + `KnowledgeChunk` (re-embedded with
     OpenAI `text-embedding-3-small` since the dimension changed)
   - Follow-up drafts → `CrmCommunication` with the `reviewStatus`
     workflow fields populated

4. **Disable `one2b-internal-agent` in production.** Stop its scheduler,
   unregister its webhooks at each provider (or point them at a
   placeholder URL). This is the point of no return for the old service.

5. **Set `EXPONENTIAL_ONE2B_WEBHOOKS_ENABLED=true`** on the exponential
   service. Re-register provider webhooks to point at exponential's
   per-workspace webhook URLs (`/api/webhooks/<provider>/<webhookId>`).
   Inbound events now flow into exponential.

6. **Set `MASTRA_ONE2B_SCHEDULERS_ENABLED=true`** on the mastra service.
   Schedulers start; pre-meeting briefs and action item reminders begin
   firing from the new system.

7. **Set `MASTRA_ONE2B_AGENTS_ENABLED=true`** on the mastra service.
   Agents are now reachable via HTTP / WhatsApp / Telegram. End-users
   start interacting with the new system.

The reason for steps 5 → 7 in that order: webhooks need somewhere to
land before agents start querying for context (otherwise the data is
stale), and schedulers shouldn't fire briefs before agents can respond
to follow-ups (otherwise users get a brief and have no way to ask for
clarification).

## Rollback

If anything in steps 5 → 7 breaks:

- Set the relevant flag back to anything other than `'true'` (e.g.
  unset, `'false'`, or remove from env).
- Re-enable `one2b-internal-agent` in production (re-point provider
  webhooks back at it; restart its scheduler).
- New events will land at the old service again.

The data migration in step 3 is **additive** — it creates new rows in
exponential without modifying or deleting Railway data. Rolling back
does not lose anything; you would just have two systems with overlapping
state until the next cutover attempt.

## Verifying each step

After flipping each flag, run a cheap smoke check before flipping the
next one.

| Step | Smoke check |
|---|---|
| 5 (webhooks on) | Send a test Fireflies webhook payload to the new URL with `curl`; expect 200 + a log line indicating processing |
| 6 (schedulers on) | Look for the cron-startup log in the mastra log; wait for one tick (≤1 hour) and check `ReminderLog` for a row |
| 7 (agents on) | `curl localhost:4111/api/agents | jq 'keys'` should now include `actionItemsAgent` (and any other one2b agents we've ported) |

## Once cutover is done

After 7 days of stable operation:

- Decommission the Railway DB used by `one2b-internal-agent`
- Archive the `one2b-internal-agent` repo (or mark its README as superseded)
- Promote the activation flags to defaults in deployment config rather
  than keeping them as one-off overrides

The flags themselves can stay in code indefinitely as a kill switch.
