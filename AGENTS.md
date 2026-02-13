# Agent Instructions

This project uses **bd** (beads) for all task tracking and planning. Run `bd prime` for full workflow context.

## Core Principle: Plan First, Always

**Never write code without a plan in beads.** Every task — no matter how small — starts with creating beads issues that describe the work. Then execute them sequentially.

### Planning Phase
```bash
# Break work into ordered steps
bd create --title="Step 1: Research/understand the problem" --type=task --priority=2
bd create --title="Step 2: Implement the change" --type=task --priority=2
bd create --title="Step 3: Test and verify" --type=task --priority=2

# Wire up dependencies so they're worked in order
bd dep add <step2-id> <step1-id>
bd dep add <step3-id> <step2-id>
```

### Execution Phase
```bash
bd ready                            # Find next unblocked work
bd show <id>                        # Review what needs doing
bd update <id> --status in_progress # Claim it
# ... do the work ...
bd close <id>                       # Mark complete
bd ready                            # Move to next
```

### Do NOT use TodoWrite. All tracking goes through beads.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

