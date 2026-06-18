import { describe, it, expect, vi } from 'vitest';

import {
  computeWindow,
  shouldPost,
  runChannelSummarizer,
  type ChannelSummarizerDeps,
  type WindowMessage,
} from './channel-summarizer.js';

describe('computeWindow', () => {
  const now = new Date('2026-06-17T10:00:00.000Z');

  it('returns the half-open window since the last watermark', () => {
    const last = new Date('2026-06-16T10:00:00.000Z');
    expect(computeWindow(last, now)).toEqual({ start: last, end: now });
  });

  it('bootstraps to one interval before now on the first run', () => {
    expect(computeWindow(null, now, 24)).toEqual({
      start: new Date('2026-06-16T10:00:00.000Z'),
      end: now,
    });
  });

  it('honors a custom interval for the bootstrap window', () => {
    expect(computeWindow(null, now, 6)).toEqual({
      start: new Date('2026-06-17T04:00:00.000Z'),
      end: now,
    });
  });
});

describe('shouldPost', () => {
  it('is false when there were no messages', () => {
    expect(shouldPost(0, 'something')).toBe(false);
  });

  it('is false when the model returns an empty / whitespace result', () => {
    expect(shouldPost(5, '')).toBe(false);
    expect(shouldPost(5, '   \n  ')).toBe(false);
  });

  it('is true when there were messages and a non-empty summary', () => {
    expect(shouldPost(3, 'Alice shipped the release.')).toBe(true);
  });
});

const NOW = new Date('2026-06-17T10:00:00.000Z');
const JID = '123@g.us';
const LAST = new Date('2026-06-16T10:00:00.000Z');

function msg(text: string): WindowMessage {
  return { senderName: 'Alice', text, timestamp: new Date() };
}

function makeDeps(
  over: Partial<ChannelSummarizerDeps> = {},
): ChannelSummarizerDeps {
  return {
    now: () => NOW,
    intervalHours: 24,
    jids: [JID],
    getConnectedUsers: () => [
      { sessionId: 's1', userId: 'u1', isConnected: true, encryptedAuthToken: 'enc' },
    ],
    decrypt: () => 'tok',
    getLastSummarizedAt: vi.fn().mockResolvedValue(LAST),
    setLastSummarizedAt: vi.fn().mockResolvedValue(undefined),
    readWindowMessages: vi.fn().mockResolvedValue([msg('hi')]),
    getGroupDisplayName: vi.fn().mockResolvedValue('Senior Staff Updates'),
    summarize: vi.fn().mockResolvedValue('Alice shipped the release.'),
    post: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('runChannelSummarizer', () => {
  it('posts a correctly-shaped payload and advances the watermark on success', async () => {
    const deps = makeDeps();
    const stats = await runChannelSummarizer(deps);

    expect(stats).toMatchObject({ posted: 1, skipped: 0, errors: 0 });
    expect(deps.post).toHaveBeenCalledWith(
      {
        provider: 'whatsapp',
        externalId: JID,
        summary: 'Alice shipped the release.',
        displayName: 'Senior Staff Updates',
        windowStart: LAST.toISOString(),
        windowEnd: NOW.toISOString(),
        messageCount: 1,
      },
      { authToken: 'tok', userId: 'u1', sessionId: 's1' },
    );
    expect(deps.setLastSummarizedAt).toHaveBeenCalledWith('u1', JID, NOW);
  });

  it('skips zero-message windows without calling the model or posting', async () => {
    const summarize = vi.fn();
    const post = vi.fn();
    const setLastSummarizedAt = vi.fn();
    const deps = makeDeps({
      readWindowMessages: vi.fn().mockResolvedValue([]),
      summarize,
      post,
      setLastSummarizedAt,
    });

    const stats = await runChannelSummarizer(deps);

    expect(stats).toMatchObject({ posted: 0, skipped: 1 });
    expect(summarize).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(setLastSummarizedAt).not.toHaveBeenCalled();
  });

  it('suppresses an empty model result — no post, no watermark advance', async () => {
    const post = vi.fn();
    const setLastSummarizedAt = vi.fn();
    const deps = makeDeps({
      summarize: vi.fn().mockResolvedValue('   '),
      post,
      setLastSummarizedAt,
    });

    const stats = await runChannelSummarizer(deps);

    expect(stats).toMatchObject({ posted: 0, skipped: 1 });
    expect(post).not.toHaveBeenCalled();
    expect(setLastSummarizedAt).not.toHaveBeenCalled();
  });

  it('does NOT advance the watermark when the POST fails (at-least-once)', async () => {
    const setLastSummarizedAt = vi.fn();
    const deps = makeDeps({
      post: vi.fn().mockRejectedValue(new Error('502 from exponential')),
      setLastSummarizedAt,
    });

    const stats = await runChannelSummarizer(deps);

    expect(stats).toMatchObject({ posted: 0, errors: 1 });
    expect(setLastSummarizedAt).not.toHaveBeenCalled();
  });

  it('does nothing when there are no watched groups', async () => {
    const post = vi.fn();
    const deps = makeDeps({ jids: [], post });

    const stats = await runChannelSummarizer(deps);

    expect(stats).toMatchObject({ groups: 0, posted: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});
