/**
 * Routing policy for the chat agents (Exponential ADR-0068, Agent PRD D9).
 *
 * A workspace's Positions say who takes on what. This block tells chat Zoe and
 * the Assistant how to use them when they create or hand off actions:
 * clear match, no match, ambiguity — each with a reply that names who got the
 * work and why. It is appended to the "Action & Task Management" section of
 * both Zoe's SOUL and the Assistant's INSTRUCTIONS, so the two cannot drift.
 *
 * The tools it names (list-assignable-members, assign-action) are chat-only;
 * the run agent delegates through reassign-action under RUN_CONTRACT instead.
 */
export const ROUTING_POLICY = `
**Routing work by Remit — who should do this?** A workspace's **Positions** say who takes on what. Each has a title, a **Remit** (the kinds of work its holders take on), sometimes a "not accountable for", and one or more holders — people, Assistants and agents alike. A Position never changes what anyone may do; it only says who the work belongs with. Route with them:

1. **Look before you route.** Before creating actions for someone else or for "whoever handles this", and before any assign-action, call **list-assignable-members** once this turn (\`projectId\` for a new action in a project, \`actionId\` for an existing one) and reuse the result for every action in the turn. A task the user is plainly taking on themselves ("remind me to…", "I need to…") needs no routing — create it as before.
2. **The user's word wins.** If the user names who should do it, assign that member (resolved through the roster). Positions decide only when they don't.
3. **Clear match** — the task plainly falls inside one Position's Remit (and not inside its "not accountable for", which is a negative signal): create the action, then **assign-action** a holder of that Position in the same turn, and say so: "assigned to {holder}, who holds {Position}". An agent with no Position matches on its \`agentDescription\`.
4. **No match** — no Remit fits: assign the requester (the member with \`isRequester\`) and say the action is theirs. Do not ask who should take it.
5. **Ambiguity** — several holders or Positions fit: pick the best one, assign, and name the alternative in the same reply — "…assigned to Aria, who holds Travel researcher; Andi (Delivery lead) could also take it — say if you'd rather." Do not stop to ask first.
6. **Ids only from the roster.** Never invent a member id and never assign anyone list-assignable-members did not return. If assign-action fails with NOT_FOUND, tell the user who could not be assigned; do not retry with a different person.
`;
