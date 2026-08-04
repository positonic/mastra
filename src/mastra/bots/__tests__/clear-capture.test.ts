import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ClearCaptureSync, type ClearCaptureMessage } from '../clear-capture.js';

const BASE_URL = 'https://clear-api.test';
const INGEST_URL = 'https://clear-api.test/api/ground/ingest';

// Deliberately fake identifiers — no real group JIDs or phone numbers.
const GROUP_JID = 'testgroup000@g.us';
const SENDER_JID = 'testsender000@s.whatsapp.net';

const fetchMock = vi.fn();

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMessage(overrides: Partial<ClearCaptureMessage> = {}): ClearCaptureMessage {
  return {
    groupJid: GROUP_JID,
    messageId: 'MSG-1',
    senderJid: SENDER_JID,
    senderName: 'Test Sender',
    timestamp: new Date('2026-08-04T12:00:00.000Z'),
    text: 'hello from the test group',
    ...overrides,
  };
}

function makeSync(): ClearCaptureSync {
  return new ClearCaptureSync(BASE_URL, 'sk_live_test_key', { minIntervalMs: 0 });
}

/** Let the fire-and-forget drain loop finish its pending work. */
async function flushDrain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okJson({ created: 1, skipped: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ClearCaptureSync.fromEnv', () => {
  it('returns null (mirror disabled) when env vars are unset', () => {
    vi.stubEnv('CLEAR_API_URL', '');
    vi.stubEnv('CLEAR_GROUND_API_KEY', '');
    expect(ClearCaptureSync.fromEnv()).toBeNull();
  });

  it('returns null when only one of the two vars is set', () => {
    vi.stubEnv('CLEAR_API_URL', BASE_URL);
    vi.stubEnv('CLEAR_GROUND_API_KEY', '');
    expect(ClearCaptureSync.fromEnv()).toBeNull();
  });

  it('returns a sync when both vars are set', () => {
    vi.stubEnv('CLEAR_API_URL', BASE_URL);
    vi.stubEnv('CLEAR_GROUND_API_KEY', 'sk_live_test_key');
    expect(ClearCaptureSync.fromEnv()).toBeInstanceOf(ClearCaptureSync);
  });
});

describe('ClearCaptureSync posting', () => {
  it('POSTs the ingest contract shape with Bearer auth', async () => {
    const sync = makeSync();
    sync.enqueue(makeMessage());
    await flushDrain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INGEST_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_live_test_key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messages: [
        {
          groupJid: GROUP_JID,
          messageId: 'MSG-1',
          senderJid: SENDER_JID,
          senderName: 'Test Sender',
          timestamp: '2026-08-04T12:00:00.000Z',
          text: 'hello from the test group',
        },
      ],
    });
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const sync = new ClearCaptureSync(`${BASE_URL}/`, 'sk_live_test_key', { minIntervalMs: 0 });
    sync.enqueue(makeMessage());
    await flushDrain();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(INGEST_URL);
  });

  it('sends null text for caption-less messages and includes mediaRefs when present', async () => {
    const sync = makeSync();
    sync.enqueue(
      makeMessage({ text: null, mediaRefs: ['image (image/jpeg, 245 kB)'] }),
    );
    await flushDrain();

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.messages[0].text).toBeNull();
    expect(body.messages[0].mediaRefs).toEqual(['image (image/jpeg, 245 kB)']);
  });

  it('omits mediaRefs entirely when there is no media', async () => {
    const sync = makeSync();
    sync.enqueue(makeMessage());
    await flushDrain();

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect('mediaRefs' in body.messages[0]).toBe(false);
  });

  it('dedupes by group + message id within a run', async () => {
    const sync = makeSync();
    sync.enqueue(makeMessage());
    sync.enqueue(makeMessage()); // same groupJid:messageId
    sync.enqueue(makeMessage({ groupJid: 'othergroup000@g.us' })); // same id, other group
    await flushDrain();

    const posted = fetchMock.mock.calls.flatMap(
      call => JSON.parse((call[1] as RequestInit).body as string).messages as unknown[],
    );
    expect(posted).toHaveLength(2);
  });

  it('batches messages queued while a POST is in flight into one request', async () => {
    let releaseFirst: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>(resolve => { releaseFirst = resolve; }),
    );

    const sync = makeSync();
    sync.enqueue(makeMessage({ messageId: 'MSG-1' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    sync.enqueue(makeMessage({ messageId: 'MSG-2' }));
    sync.enqueue(makeMessage({ messageId: 'MSG-3' }));

    releaseFirst(okJson({ created: 1, skipped: 0 }));
    await flushDrain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(secondBody.messages.map((m: { messageId: string }) => m.messageId)).toEqual([
      'MSG-2',
      'MSG-3',
    ]);
  });
});

describe('ClearCaptureSync failure handling', () => {
  it('treats a 403 consent rejection as final: no retry, no throw, drain continues', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson(
        {
          error: 'Consent gate: live capture is not permitted for this payload',
          rejections: [{ groupJid: GROUP_JID, reason: 'no ground source registered for this JID' }],
        },
        403,
      ),
    );

    const sync = makeSync();
    sync.enqueue(makeMessage({ messageId: 'MSG-403' }));
    await flushDrain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The mirror keeps working for later messages.
    sync.enqueue(makeMessage({ messageId: 'MSG-AFTER' }));
    await flushDrain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swallows server errors without retrying the failed batch', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const sync = makeSync();
    sync.enqueue(makeMessage({ messageId: 'MSG-500' }));
    await flushDrain();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sync.enqueue(makeMessage({ messageId: 'MSG-NEXT' }));
    await flushDrain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(lastBody.messages.map((m: { messageId: string }) => m.messageId)).toEqual(['MSG-NEXT']);
  });

  it('swallows network errors (fetch rejection) without throwing to the caller', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const sync = makeSync();
    expect(() => sync.enqueue(makeMessage({ messageId: 'MSG-NET' }))).not.toThrow();
    await flushDrain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
