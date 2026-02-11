# Telegram Integration — Exponential App Spec

## Context

The Mastra backend now has a **multi-tenant Telegram gateway** that lets any Exponential user chat with their assistant agent from Telegram. It works via a single shared bot — users pair their Telegram account by tapping a deep link.

The gateway is already built and running on port 4113. This spec describes what the Exponential app needs to build so users can connect from `/settings/integrations`.

## How It Works (End-to-End)

1. User visits Settings > Integrations, sees a "Telegram" card
2. User clicks "Connect Telegram"
3. Exponential calls `POST {TELEGRAM_GATEWAY_URL}/pair` with a fresh JWT
4. Gateway returns `{ pairingCode, botUsername, expiresInSeconds }`
5. UI shows a deep link: `https://t.me/{botUsername}?start={pairingCode}`
6. User taps the link — Telegram opens and auto-sends `/start CODE` to the bot
7. Bot validates the code, pairs the account, stores the encrypted JWT
8. UI polls `GET {TELEGRAM_GATEWAY_URL}/status` until it sees `{ paired: true }`
9. UI switches to "Connected" state

This mirrors the WhatsApp gateway flow (QR code → poll for status) but is simpler — no QR image, just a clickable link.

---

## 1. Environment Variables

Add to `.env`:

```
TELEGRAM_GATEWAY_URL=http://localhost:4113    # Mastra Telegram gateway URL
```

In production this would be `https://your-mastra-host:4113` or wherever the gateway is deployed.

No new secrets needed — the existing `AUTH_SECRET` is used for JWT signing (same as WhatsApp gateway).

---

## 2. Database: Prisma Schema

Add a new model to track Telegram connection state (mirrors `WhatsAppGatewaySession`):

```prisma
model TelegramGatewaySession {
  id             String    @id @default(cuid())

  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  telegramUsername String?   // Set after pairing completes
  agentId        String    @default("assistant")  // Default agent
  status         TelegramGatewayStatus @default(DISCONNECTED)

  connectedAt    DateTime?
  lastActiveAt   DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([userId])  // One Telegram connection per user
}

enum TelegramGatewayStatus {
  DISCONNECTED
  CONNECTED
}
```

Run `npx prisma migrate dev --name add-telegram-gateway-session` after adding.

Also add to the `User` model:
```prisma
model User {
  // ... existing fields
  telegramGatewaySession  TelegramGatewaySession?
}
```

---

## 3. Backend: tRPC Router

Create `src/server/api/routers/telegramGateway.ts`:

```typescript
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { z } from "zod";
import { generateJWT } from "../../utils/jwt";

const TELEGRAM_GATEWAY_URL = process.env.TELEGRAM_GATEWAY_URL || "http://localhost:4113";

export const telegramGatewayRouter = createTRPCRouter({

  // Check if user has a connected Telegram account
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    // First check local DB
    const session = await ctx.db.telegramGatewaySession.findUnique({
      where: { userId: ctx.session.user.id },
    });

    // Also check the gateway for live status
    try {
      const authToken = generateJWT(ctx.session.user, { tokenType: "telegram-gateway" });
      const res = await fetch(`${TELEGRAM_GATEWAY_URL}/status`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (res.ok) {
        const data = await res.json();

        if (data.paired && (!session || session.status !== "CONNECTED")) {
          // Gateway says paired but DB doesn't reflect it — sync
          await ctx.db.telegramGatewaySession.upsert({
            where: { userId: ctx.session.user.id },
            create: {
              userId: ctx.session.user.id,
              telegramUsername: data.telegramUsername,
              agentId: data.agentId || "assistant",
              status: "CONNECTED",
              connectedAt: new Date(),
              lastActiveAt: data.lastActive ? new Date(data.lastActive) : null,
            },
            update: {
              telegramUsername: data.telegramUsername,
              agentId: data.agentId || "assistant",
              status: "CONNECTED",
              lastActiveAt: data.lastActive ? new Date(data.lastActive) : null,
            },
          });

          return { paired: true, telegramUsername: data.telegramUsername, agentId: data.agentId, lastActive: data.lastActive };
        }

        if (!data.paired && session?.status === "CONNECTED") {
          // Gateway says not paired but DB says connected — sync
          await ctx.db.telegramGatewaySession.update({
            where: { userId: ctx.session.user.id },
            data: { status: "DISCONNECTED", telegramUsername: null },
          });
          return { paired: false };
        }

        return data;
      }
    } catch (error) {
      console.error("[telegramGateway] Failed to check gateway status:", error);
    }

    // Fallback to DB state
    return {
      paired: session?.status === "CONNECTED",
      telegramUsername: session?.telegramUsername,
      agentId: session?.agentId,
      lastActive: session?.lastActiveAt?.toISOString(),
    };
  }),

  // Generate pairing code and return deep link
  initiatePairing: protectedProcedure
    .input(z.object({
      agentId: z.string().default("assistant"),
    }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateJWT(ctx.session.user, { tokenType: "telegram-gateway" });

      const res = await fetch(`${TELEGRAM_GATEWAY_URL}/pair`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agentId: input.agentId }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Gateway error" }));
        throw new Error(error.error || `Gateway returned ${res.status}`);
      }

      const data = await res.json();

      // Create/update a DISCONNECTED session so we know pairing was initiated
      await ctx.db.telegramGatewaySession.upsert({
        where: { userId: ctx.session.user.id },
        create: {
          userId: ctx.session.user.id,
          agentId: input.agentId,
          status: "DISCONNECTED",
        },
        update: {
          agentId: input.agentId,
          status: "DISCONNECTED",
        },
      });

      return {
        pairingCode: data.pairingCode,
        botUsername: data.botUsername,
        deepLink: `https://t.me/${data.botUsername}?start=${data.pairingCode}`,
        expiresInSeconds: data.expiresInSeconds,
      };
    }),

  // Disconnect Telegram account
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    const authToken = generateJWT(ctx.session.user, { tokenType: "telegram-gateway" });

    try {
      await fetch(`${TELEGRAM_GATEWAY_URL}/pair`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch (error) {
      console.error("[telegramGateway] Failed to call gateway disconnect:", error);
    }

    // Always update local DB regardless of gateway response
    await ctx.db.telegramGatewaySession.update({
      where: { userId: ctx.session.user.id },
      data: { status: "DISCONNECTED", telegramUsername: null },
    }).catch(() => {}); // Ignore if no session exists

    return { success: true };
  }),

  // Update agent selection
  updateSettings: protectedProcedure
    .input(z.object({
      agentId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const authToken = generateJWT(ctx.session.user, { tokenType: "telegram-gateway" });

      try {
        await fetch(`${TELEGRAM_GATEWAY_URL}/settings`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ agentId: input.agentId }),
        });
      } catch (error) {
        console.error("[telegramGateway] Failed to update gateway settings:", error);
      }

      await ctx.db.telegramGatewaySession.update({
        where: { userId: ctx.session.user.id },
        data: { agentId: input.agentId },
      });

      return { success: true };
    }),
});
```

Register in `src/server/api/root.ts`:
```typescript
import { telegramGatewayRouter } from "./routers/telegramGateway";

export const appRouter = createTRPCRouter({
  // ... existing routers
  telegramGateway: telegramGatewayRouter,
});
```

---

## 4. Backend: JWT Token Type

In `src/server/utils/jwt.ts`, add `"telegram-gateway"` to the allowed token types. It should use the same claims as `"whatsapp-gateway"`:

```typescript
// In the DEFAULT_EXPIRY map or switch:
"telegram-gateway": 60, // 60 minutes, same as whatsapp-gateway

// Same claims:
//   aud: "mastra-agents"
//   iss: "todo-app"
```

The Mastra gateway verifies tokens with `audience: "mastra-agents"` and `issuer: "todo-app"` — these must match.

---

## 5. Backend: Token Refresh Endpoint

Create `src/app/api/telegram-gateway/refresh-token/route.ts`:

This is identical to the WhatsApp gateway refresh endpoint but for Telegram sessions.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "~/server/db";
import { generateJWT } from "~/server/utils/jwt";

const GATEWAY_SECRET = process.env.GATEWAY_SECRET || process.env.WHATSAPP_GATEWAY_SECRET;

export async function POST(request: NextRequest) {
  // Verify gateway secret
  const gatewaySecret = request.headers.get("X-Gateway-Secret");
  if (!GATEWAY_SECRET || gatewaySecret !== GATEWAY_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Look up user
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Generate fresh token
  const token = generateJWT(
    { id: user.id, email: user.email, name: user.name, image: user.image },
    { tokenType: "telegram-gateway" }
  );

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  // Update lastActiveAt
  await db.telegramGatewaySession.updateMany({
    where: { userId },
    data: { lastActiveAt: new Date() },
  });

  return NextResponse.json({ token, expiresAt });
}
```

---

## 6. Frontend: Telegram Integration Card

Add a Telegram section to the settings/integrations page. This can either be:
- A card on the existing integrations page (like Google Calendar), or
- A new entry in `IntegrationsClient.tsx` PROVIDER_OPTIONS

**Recommended**: Add it as a standalone card on the integrations page (like how Google Calendar is its own section), since it doesn't follow the generic Integration CRUD model — it's a simple connect/disconnect flow.

Create `src/app/_components/TelegramGatewayCard.tsx`:

```tsx
"use client";

import { useState, useEffect, useRef } from "react";
import {
  Card, Text, Button, Group, Badge, Stack, Select, Anchor, Loader,
} from "@mantine/core";
import { IconBrandTelegram } from "@tabler/icons-react";
import { api } from "~/trpc/react";

const AGENT_OPTIONS = [
  { value: "assistant", label: "Assistant (customizable)" },
  { value: "zoe",       label: "Zoe (companion)" },
  { value: "paddy",     label: "Paddy (project manager)" },
  { value: "pierre",    label: "Pierre (crypto trading)" },
  { value: "ash",       label: "Ash (lean startup)" },
  { value: "weather",   label: "Weather Agent" },
];

export function TelegramGatewayCard() {
  const [agentId, setAgentId] = useState("assistant");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const status = api.telegramGateway.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });

  const initiatePairing = api.telegramGateway.initiatePairing.useMutation({
    onSuccess: () => {
      // Start polling for pairing completion
      pollRef.current = setInterval(() => {
        status.refetch();
      }, 2500);
    },
  });

  const disconnect = api.telegramGateway.disconnect.useMutation({
    onSuccess: () => status.refetch(),
  });

  const updateSettings = api.telegramGateway.updateSettings.useMutation();

  // Stop polling when paired
  useEffect(() => {
    if (status.data?.paired && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status.data?.paired]);

  const isPaired = status.data?.paired;
  const isPairing = initiatePairing.isSuccess && !isPaired;

  return (
    <Card withBorder radius="md" p="lg">
      <Group justify="space-between" mb="md">
        <Group gap="sm">
          <IconBrandTelegram size={24} color="#2AABEE" />
          <Text fw={600}>Telegram</Text>
        </Group>
        <Badge color={isPaired ? "green" : "gray"} variant="light">
          {isPaired ? "Connected" : "Not connected"}
        </Badge>
      </Group>

      {isPaired ? (
        // ─── Connected state ───
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Connected as <b>@{status.data.telegramUsername}</b>
          </Text>

          <Select
            label="Default agent"
            data={AGENT_OPTIONS}
            value={status.data.agentId || "assistant"}
            onChange={(value) => {
              if (value) updateSettings.mutate({ agentId: value });
            }}
          />

          <Button
            variant="light"
            color="red"
            onClick={() => disconnect.mutate()}
            loading={disconnect.isPending}
          >
            Disconnect Telegram
          </Button>
        </Stack>
      ) : isPairing ? (
        // ─── Pairing in progress ───
        <Stack gap="sm" align="center">
          <Text size="sm" ta="center">
            Tap the link below to open Telegram and connect:
          </Text>

          <Button
            component="a"
            href={initiatePairing.data?.deepLink}
            target="_blank"
            rel="noopener"
            leftSection={<IconBrandTelegram size={18} />}
            size="md"
          >
            Open in Telegram
          </Button>

          <Group gap="xs">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">Waiting for you to tap the link...</Text>
          </Group>
        </Stack>
      ) : (
        // ─── Disconnected state ───
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Chat with your AI assistant directly from Telegram.
          </Text>

          <Select
            label="Default agent"
            data={AGENT_OPTIONS}
            value={agentId}
            onChange={(value) => setAgentId(value || "assistant")}
          />

          <Button
            onClick={() => initiatePairing.mutate({ agentId })}
            loading={initiatePairing.isPending}
            leftSection={<IconBrandTelegram size={18} />}
          >
            Connect Telegram
          </Button>
        </Stack>
      )}
    </Card>
  );
}
```

---

## 7. Frontend: Add to Integrations Page

In `src/app/(sidemenu)/settings/integrations/page.tsx`, add the Telegram card alongside the existing integrations:

```tsx
import { TelegramGatewayCard } from "~/app/_components/TelegramGatewayCard";

// Inside the page component, add alongside the Google Calendar section:
<TelegramGatewayCard />
```

---

## 8. Gateway API Reference

The Mastra Telegram gateway runs at `TELEGRAM_GATEWAY_URL` (default `http://localhost:4113`).

All endpoints require `Authorization: Bearer {JWT}` where the JWT is signed with `AUTH_SECRET`, has `aud: "mastra-agents"`, and `iss: "todo-app"`.

| Method | Endpoint | Request Body | Response |
|--------|----------|-------------|----------|
| `POST` | `/pair` | `{ agentId?: string, assistantId?: string, workspaceId?: string }` | `{ pairingCode: string, botUsername: string, expiresInSeconds: number }` |
| `DELETE` | `/pair` | — | `{ success: true }` |
| `GET` | `/status` | — | `{ paired: boolean, telegramUsername?: string, agentId?: string, lastActive?: string }` |
| `PUT` | `/settings` | `{ agentId?: string, assistantId?: string }` | `{ success: true, agentId: string }` |

**Error responses** follow `{ error: string }` with appropriate HTTP status codes (401 for auth errors, 404 for not found).

---

## 9. Token Refresh Flow

When a user's JWT expires (after 60 minutes), the Mastra gateway will call:

```
POST {TODO_APP_BASE_URL}/api/telegram-gateway/refresh-token
Headers: X-Gateway-Secret: {GATEWAY_SECRET}
Body: { "userId": "the-user-id" }
```

The Exponential app responds with a fresh JWT. This keeps long-running Telegram sessions alive without the user needing to re-pair.

---

## Summary of Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `src/server/api/routers/telegramGateway.ts` | tRPC router (getStatus, initiatePairing, disconnect, updateSettings) |
| Create | `src/app/api/telegram-gateway/refresh-token/route.ts` | Token refresh endpoint |
| Create | `src/app/_components/TelegramGatewayCard.tsx` | Frontend card component |
| Modify | `src/server/api/root.ts` | Register `telegramGatewayRouter` |
| Modify | `src/server/utils/jwt.ts` | Add `"telegram-gateway"` token type |
| Modify | `prisma/schema.prisma` | Add `TelegramGatewaySession` model + `TelegramGatewayStatus` enum |
| Modify | `src/app/(sidemenu)/settings/integrations/page.tsx` | Add `<TelegramGatewayCard />` |
| Modify | `.env` | Add `TELEGRAM_GATEWAY_URL` |
