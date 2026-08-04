import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  ClearCaptureSync,
  describeCaptureMedia,
  formatMediaRef,
  mediaFileName,
  type CaptureMediaInfo,
  type ClearCaptureMessage,
} from '../clear-capture.js';

const BASE_URL = 'https://clear-api.test';
const INGEST_URL = 'https://clear-api.test/api/ground/ingest';
const MEDIA_URL = 'https://clear-api.test/api/ground/media';

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

function makeMediaSync(options?: { mediaTimeoutMs?: number }): ClearCaptureSync {
  return new ClearCaptureSync(BASE_URL, 'sk_live_test_key', {
    minIntervalMs: 0,
    mediaTimeoutMs: options?.mediaTimeoutMs ?? 250,
  });
}

function makeMediaInfo(overrides: Partial<CaptureMediaInfo> = {}): CaptureMediaInfo {
  return {
    kind: 'image',
    fileName: null,
    mimetype: 'image/jpeg',
    sizeBytes: 3,
    caption: null,
    ...overrides,
  };
}

const MEDIA_KEY = 'ground-media/testgroup000/abc123.jpg';

function mediaOkBody(key = MEDIA_KEY): unknown {
  return { key, groundSourceId: 'gs_test_1', deduplicated: false, attached: false };
}

/** Route the fetch mock by URL: media responses are injectable, ingest
 * always succeeds. */
function routeFetch(mediaResponse: () => Response | Promise<Response>): void {
  fetchMock.mockImplementation((url: unknown) =>
    Promise.resolve(url === MEDIA_URL ? mediaResponse() : okJson({ created: 1, skipped: 0 })),
  );
}

function callsTo(url: string): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(call => call[0] === url) as Array<[string, RequestInit]>;
}

function ingestedMessages(): Array<Record<string, unknown>> {
  return callsTo(INGEST_URL).flatMap(
    ([, init]) => JSON.parse(init.body as string).messages as Array<Record<string, unknown>>,
  );
}

/** Let the fire-and-forget drain loop finish its pending work. */
async function flushDrain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Poll until a condition holds (for paths gated on real timers). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
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

describe('describeCaptureMedia', () => {
  it('returns null for pure text messages', () => {
    expect(describeCaptureMedia({ })).toBeNull();
    expect(describeCaptureMedia(null)).toBeNull();
    expect(describeCaptureMedia(undefined)).toBeNull();
  });

  it('describes an image with mimetype and size (no filename in the proto)', () => {
    const info = describeCaptureMedia({
      imageMessage: { mimetype: 'image/jpeg', fileLength: 251000, caption: 'a caption' },
    });
    expect(info).toEqual({
      kind: 'image',
      fileName: null,
      mimetype: 'image/jpeg',
      sizeBytes: 251000,
      caption: 'a caption',
    });
  });

  it('describes a video and tolerates a Long-style fileLength', () => {
    const info = describeCaptureMedia({
      videoMessage: { mimetype: 'video/mp4', fileLength: { toString: () => '1048576' } },
    });
    expect(info).toEqual({
      kind: 'video',
      fileName: null,
      mimetype: 'video/mp4',
      sizeBytes: 1048576,
      caption: null,
    });
  });

  it('describes a document with its filename', () => {
    const info = describeCaptureMedia({
      documentMessage: {
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        fileLength: 1258291,
      },
    });
    expect(info).toEqual({
      kind: 'document',
      fileName: 'report.pdf',
      mimetype: 'application/pdf',
      sizeBytes: 1258291,
      caption: null,
    });
  });

  it('unwraps documentWithCaptionMessage and keeps its caption', () => {
    const info = describeCaptureMedia({
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            fileName: 'notes.docx',
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            fileLength: 2048,
            caption: 'the caption lives on the document',
          },
        },
      },
    });
    expect(info?.kind).toBe('document');
    expect(info?.fileName).toBe('notes.docx');
    expect(info?.caption).toBe('the caption lives on the document');
  });

  it('ignores media kinds the mirror does not cover', () => {
    expect(
      describeCaptureMedia({
        // audio/sticker etc. are not image/video/document
      }),
    ).toBeNull();
  });

  it('treats an invalid fileLength as unknown size', () => {
    const info = describeCaptureMedia({
      imageMessage: { mimetype: 'image/png', fileLength: { toString: () => 'not-a-number' } },
    });
    expect(info?.sizeBytes).toBeNull();
  });
});

describe('formatMediaRef', () => {
  const base: CaptureMediaInfo = {
    kind: 'image',
    fileName: null,
    mimetype: null,
    sizeBytes: null,
    caption: null,
  };

  it('uses the filename when known', () => {
    expect(
      formatMediaRef({
        ...base,
        kind: 'document',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        sizeBytes: 1258291,
      }),
    ).toBe('report.pdf (application/pdf, 1.2 MB)');
  });

  it('falls back to the media kind when there is no filename', () => {
    expect(
      formatMediaRef({ ...base, mimetype: 'image/jpeg', sizeBytes: 251000 }),
    ).toBe('image (image/jpeg, 245 kB)');
  });

  it('renders small sizes in bytes and omits missing details', () => {
    expect(formatMediaRef({ ...base, sizeBytes: 512 })).toBe('image (512 B)');
    expect(formatMediaRef(base)).toBe('image');
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

describe('mediaFileName', () => {
  it('keeps the real document filename when the proto has one', () => {
    expect(
      mediaFileName(makeMediaInfo({ kind: 'document', fileName: 'report.pdf', mimetype: 'application/pdf' })),
    ).toBe('report.pdf');
  });

  it('derives kind + extension from the mimetype otherwise', () => {
    expect(mediaFileName(makeMediaInfo({ mimetype: 'image/jpeg' }))).toBe('image.jpg');
    expect(mediaFileName(makeMediaInfo({ kind: 'video', mimetype: 'video/mp4' }))).toBe('video.mp4');
    expect(mediaFileName(makeMediaInfo({ mimetype: 'image/heic' }))).toBe('image.heic');
  });

  it('falls back to .bin when the mimetype is unknown', () => {
    expect(mediaFileName(makeMediaInfo({ mimetype: null }))).toBe('image.bin');
  });
});

describe('ClearCaptureSync media upload', () => {
  it('uploads the bytes to /api/ground/media (multipart, Bearer) before the ingest POST', async () => {
    routeFetch(() => okJson(mediaOkBody()));
    const bytes = new Uint8Array([1, 2, 3]);
    const download = vi.fn().mockResolvedValue(bytes);

    const sync = makeMediaSync();
    sync.enqueue(
      makeMessage({
        messageId: 'MSG-MEDIA-1',
        text: null,
        mediaRefs: ['image (image/jpeg, 3 B)'],
        media: { info: makeMediaInfo(), download },
      }),
    );
    await flushDrain();

    expect(download).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([MEDIA_URL, INGEST_URL]);

    const [, init] = callsTo(MEDIA_URL)[0]!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_live_test_key');
    // FormData must set its own multipart boundary.
    expect(headers['Content-Type']).toBeUndefined();

    const form = init.body as FormData;
    expect(form.get('groupJid')).toBe(GROUP_JID);
    expect(form.get('sourceMessageExternalId')).toBe(`whatsapp:${GROUP_JID}:MSG-MEDIA-1`);
    const file = form.get('file') as File;
    expect(file.name).toBe('image.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('ships the returned S3 key as mediaKeys in the ingest payload, keeping the refs', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync();
    sync.enqueue(
      makeMessage({
        messageId: 'MSG-MEDIA-2',
        text: 'caption text',
        mediaRefs: ['image (image/jpeg, 3 B)'],
        media: { info: makeMediaInfo(), download: vi.fn().mockResolvedValue(new Uint8Array(3)) },
      }),
    );
    await flushDrain();

    const [message] = ingestedMessages();
    expect(message?.mediaKeys).toEqual([MEDIA_KEY]);
    expect(message?.mediaRefs).toEqual(['image (image/jpeg, 3 B)']);
    expect(message?.text).toBe('caption text');
    // The internal media handle never leaks into the wire payload.
    expect(message && 'media' in message).toBe(false);
  });

  it('uses the real document filename and content type for the file part', async () => {
    routeFetch(() => okJson(mediaOkBody('ground-media/testgroup000/report.pdf')));

    const sync = makeMediaSync();
    sync.enqueue(
      makeMessage({
        messageId: 'MSG-MEDIA-3',
        media: {
          info: makeMediaInfo({ kind: 'document', fileName: 'report.pdf', mimetype: 'application/pdf' }),
          download: vi.fn().mockResolvedValue(new Uint8Array([9])),
        },
      }),
    );
    await flushDrain();

    const file = (callsTo(MEDIA_URL)[0]![1].body as FormData).get('file') as File;
    expect(file.name).toBe('report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(ingestedMessages()[0]?.mediaKeys).toEqual(['ground-media/testgroup000/report.pdf']);
  });

  it('never touches the media endpoint for text-only messages', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync();
    sync.enqueue(makeMessage({ messageId: 'MSG-TEXT-ONLY' }));
    await flushDrain();

    expect(callsTo(MEDIA_URL)).toHaveLength(0);
    expect(callsTo(INGEST_URL)).toHaveLength(1);
    expect('mediaKeys' in ingestedMessages()[0]!).toBe(false);
  });
});

describe('ClearCaptureSync media failure posture', () => {
  const REFS = ['image (image/jpeg, 3 B)'];

  function makeMediaMessage(
    messageId: string,
    media: ClearCaptureMessage['media'],
  ): ClearCaptureMessage {
    return makeMessage({ messageId, text: null, mediaRefs: REFS, media });
  }

  function expectDegradedIngest(messageId: string): void {
    const message = ingestedMessages().find(m => m.messageId === messageId);
    expect(message).toBeDefined();
    expect('mediaKeys' in message!).toBe(false);
    expect(message!.mediaRefs).toEqual(REFS);
  }

  it('skips the download and upload entirely when the declared size exceeds 50 MB', async () => {
    routeFetch(() => okJson(mediaOkBody()));
    const download = vi.fn().mockResolvedValue(new Uint8Array(1));

    const sync = makeMediaSync();
    sync.enqueue(
      makeMediaMessage('MSG-TOO-BIG', {
        info: makeMediaInfo({ sizeBytes: 51 * 1024 * 1024 }),
        download,
      }),
    );
    await flushDrain();

    expect(download).not.toHaveBeenCalled();
    expect(callsTo(MEDIA_URL)).toHaveLength(0);
    expectDegradedIngest('MSG-TOO-BIG');
  });

  it('rechecks the real byte count after download (proto sizes can lie)', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync();
    sync.enqueue(
      makeMediaMessage('MSG-LIED', {
        info: makeMediaInfo({ sizeBytes: null }),
        download: vi.fn().mockResolvedValue(new Uint8Array(50 * 1024 * 1024 + 1)),
      }),
    );
    await flushDrain();

    expect(callsTo(MEDIA_URL)).toHaveLength(0);
    expectDegradedIngest('MSG-LIED');
  });

  it('degrades to metadata refs when the download itself fails', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync();
    expect(() =>
      sync.enqueue(
        makeMediaMessage('MSG-DL-FAIL', {
          info: makeMediaInfo(),
          download: vi.fn().mockRejectedValue(new Error('media no longer available')),
        }),
      ),
    ).not.toThrow();
    await flushDrain();

    expect(callsTo(MEDIA_URL)).toHaveLength(0);
    expectDegradedIngest('MSG-DL-FAIL');
  });

  it('degrades on a media 500 with exactly one upload attempt (no hot retry)', async () => {
    routeFetch(() => new Response('boom', { status: 500 }));

    const sync = makeMediaSync();
    sync.enqueue(
      makeMediaMessage('MSG-UP-500', {
        info: makeMediaInfo(),
        download: vi.fn().mockResolvedValue(new Uint8Array(3)),
      }),
    );
    await flushDrain();

    expect(callsTo(MEDIA_URL)).toHaveLength(1);
    expectDegradedIngest('MSG-UP-500');
  });

  it('treats a media 403 consent rejection as final: no retry, ingest still runs', async () => {
    routeFetch(() =>
      okJson({ error: 'Consent gate', reason: 'no message-content consent for this group' }, 403),
    );

    const sync = makeMediaSync();
    sync.enqueue(
      makeMediaMessage('MSG-UP-403', {
        info: makeMediaInfo(),
        download: vi.fn().mockResolvedValue(new Uint8Array(3)),
      }),
    );
    await flushDrain();

    expect(callsTo(MEDIA_URL)).toHaveLength(1);
    expectDegradedIngest('MSG-UP-403');
  });

  it('degrades when the download hangs past the media timeout', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync({ mediaTimeoutMs: 20 });
    sync.enqueue(
      makeMediaMessage('MSG-HANG', {
        info: makeMediaInfo(),
        download: () => new Promise<Uint8Array>(() => { /* never resolves */ }),
      }),
    );

    await until(() => ingestedMessages().some(m => m.messageId === 'MSG-HANG'));
    expect(callsTo(MEDIA_URL)).toHaveLength(0);
    expectDegradedIngest('MSG-HANG');
  });

  it('never delays text mirroring behind a pending media upload', async () => {
    routeFetch(() => okJson(mediaOkBody()));

    const sync = makeMediaSync({ mediaTimeoutMs: 50 });
    sync.enqueue(
      makeMediaMessage('MSG-SLOW-MEDIA', {
        info: makeMediaInfo(),
        download: () => new Promise<Uint8Array>(() => { /* pending */ }),
      }),
    );
    sync.enqueue(makeMessage({ messageId: 'MSG-FAST-TEXT' }));

    // The text message ships while the media download is still pending.
    await until(() => ingestedMessages().some(m => m.messageId === 'MSG-FAST-TEXT'));
    expect(ingestedMessages().some(m => m.messageId === 'MSG-SLOW-MEDIA')).toBe(false);

    // ...and the media message still arrives (degraded) after the timeout.
    await until(() => ingestedMessages().some(m => m.messageId === 'MSG-SLOW-MEDIA'));
    expectDegradedIngest('MSG-SLOW-MEDIA');
  });

  it('falls back straight to metadata refs when the media queue is saturated', async () => {
    routeFetch(() => okJson(mediaOkBody()));
    // The busy slot hangs (generous timeout so it outlives the assertions);
    // the queued ones resolve instantly so nothing lingers after the test.
    const hanging = { info: makeMediaInfo(), download: () => new Promise<Uint8Array>(() => { /* pending */ }) };
    const quick = { info: makeMediaInfo(), download: () => Promise.resolve(new Uint8Array(1)) };

    const sync = makeMediaSync({ mediaTimeoutMs: 1000 });
    // First message occupies the single-flight worker...
    sync.enqueue(makeMediaMessage('MSG-BUSY', hanging));
    await new Promise(resolve => setTimeout(resolve, 0));
    // ...the next 200 fill the media queue to its cap...
    for (let i = 0; i < 200; i++) {
      sync.enqueue(makeMediaMessage(`MSG-QUEUED-${i}`, quick));
    }
    // ...so this one skips its upload and ships immediately with refs only.
    sync.enqueue(makeMediaMessage('MSG-OVERFLOW', quick));

    await until(() => ingestedMessages().some(m => m.messageId === 'MSG-OVERFLOW'));
    expectDegradedIngest('MSG-OVERFLOW');
    // The saturated queue is still waiting behind the busy worker.
    expect(ingestedMessages().some(m => m.messageId === 'MSG-QUEUED-0')).toBe(false);
  });
});
