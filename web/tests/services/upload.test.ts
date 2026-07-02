import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadFile } from '../../src/services/upload';

// T36 — upload service tests. We stub XMLHttpRequest so we can
// drive transport-progress events, the load event, and aborts
// deterministically without hitting the network.
//
// The contract being tested:
//   - upload.onprogress ticks fire UploadProgress(loaded, total).
//   - 2xx with a JSON body → resolves to the parsed body.
//   - 4xx/5xx with `{ error }` → rejects with the error message.
//   - 4xx with non-JSON body → rejects with "HTTP <status>".
//   - abort (via signal) → rejects with "aborted".
//   - skip when lengthComputable is false (avoids /0).

type Listener = (e?: unknown) => void;

interface FakeXHRState {
  method: string;
  url: string;
  withCredentials: boolean;
  listeners: Record<string, Listener[]>;
  uploadListeners: Record<string, Listener[]>;
  sentBody: BodyInit | null;
  status: number;
  responseText: string;
}

function makeFakeXHR() {
  const state: FakeXHRState = {
    method: '',
    url: '',
    withCredentials: false,
    listeners: {},
    uploadListeners: {},
    sentBody: null,
    status: 0,
    responseText: '',
  };

  const xhr: {
    state: FakeXHRState;
    fireUploadProgress: (loaded: number, total: number, lengthComputable?: boolean) => void;
    fireLoad: (status: number, body: string) => void;
    fireError: () => void;
    fireAbort: () => void;
    triggerSignalAbort: () => void;
    sent: { form: FormData | null };
  } = {
    state,
    fireUploadProgress: (loaded, total, lengthComputable = true) => {
      const ev = { loaded, total, lengthComputable };
      for (const fn of state.uploadListeners.progress ?? []) fn(ev);
    },
    fireLoad: (status, body) => {
      state.status = status;
      state.responseText = body;
      for (const fn of state.listeners.load ?? []) fn();
    },
    fireError: () => {
      for (const fn of state.listeners.error ?? []) fn();
    },
    fireAbort: () => {
      for (const fn of state.listeners.abort ?? []) fn();
    },
    triggerSignalAbort: () => {
      // Reach into the AbortSignal the test passed and trigger its
      // abort callback so the service wires up its xhr.abort().
      xhr.sent.form = null; // (placeholder for the test harness's own state)
    },
    sent: { form: null },
  };

  const ctor: unknown = function (this: unknown) {
    const self: Record<string, unknown> = {};
    self.open = (method: string, url: string) => {
      state.method = method;
      state.url = url;
    };
    self.setRequestHeader = () => {};
    self.withCredentials = false;
    Object.defineProperty(self, 'upload', {
      get: () => ({
        addEventListener: (name: string, fn: Listener) => {
          (state.uploadListeners[name] ||= []).push(fn);
        },
      }),
    });
    self.addEventListener = (name: string, fn: Listener) => {
      (state.listeners[name] ||= []).push(fn);
    };
    self.abort = () => xhr.fireAbort();
    Object.defineProperty(self, 'status', {
      get: () => state.status,
    });
    Object.defineProperty(self, 'responseText', {
      get: () => state.responseText,
    });
    self.send = (body: BodyInit) => {
      state.sentBody = body;
      xhr.sent.form = body as FormData;
    };
    return self;
  };

  return { xhr, ctor };
}

describe('uploadFile', () => {
  let xhrFactory: ReturnType<typeof makeFakeXHR>;

  beforeEach(() => {
    xhrFactory = makeFakeXHR();
    vi.stubGlobal('XMLHttpRequest', xhrFactory.ctor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFile(name = 'note.md'): File {
    return new File(['# hello'], name, { type: 'text/markdown' });
  }

  it('POSTs to /api/upload with FormData', () => {
    const handle = uploadFile(makeFile());
    // The factory captures `send()`'s body; check the URL.
    expect(xhrFactory.xhr.state.url).toBe('/api/upload');
    expect(xhrFactory.xhr.state.method).toBe('POST');
    expect(xhrFactory.xhr.state.sentBody).toBeInstanceOf(FormData);
    void handle.promise.catch(() => {});
  });

  it('forwards transport-progress events to the callback (loaded/total → pct)', async () => {
    const onProgress = vi.fn();
    const handle = uploadFile(makeFile('a.md'), onProgress);
    const promise = handle.promise.catch(() => 'error');

    xhrFactory.xhr.fireUploadProgress(0, 100);
    xhrFactory.xhr.fireUploadProgress(50, 100);
    xhrFactory.xhr.fireUploadProgress(100, 100);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 100);
    expect(onProgress).toHaveBeenNthCalledWith(2, 50, 100);
    expect(onProgress).toHaveBeenNthCalledWith(3, 100, 100);

    xhrFactory.xhr.fireLoad(200, JSON.stringify({ success: true, chunksIndexed: 3 }));
    await promise;
  });

  it('skips the progress tick when lengthComputable is false', async () => {
    const onProgress = vi.fn();
    const handle = uploadFile(makeFile('b.md'), onProgress);
    const promise = handle.promise.catch(() => 'error');

    xhrFactory.xhr.fireUploadProgress(0, 0, false);
    expect(onProgress).not.toHaveBeenCalled();

    xhrFactory.xhr.fireLoad(200, JSON.stringify({ success: true }));
    await promise;
  });

  it('resolves with the parsed JSON body on 2xx', async () => {
    const handle = uploadFile(makeFile('c.md'));
    const result = await new Promise((resolve, reject) => {
      handle.promise.then(resolve, reject);
      xhrFactory.xhr.fireLoad(
        200,
        JSON.stringify({ success: true, fileName: 'c.md', chunksIndexed: 7, fileId: 'fid' })
      );
    });
    expect(result).toEqual({
      success: true,
      fileName: 'c.md',
      chunksIndexed: 7,
      fileId: 'fid',
    });
  });

  it('rejects with the server error field on 4xx/5xx JSON body', async () => {
    const handle = uploadFile(makeFile('d.md'));
    const err = await new Promise<unknown>((resolve) => {
      handle.promise.then(
        () => resolve(null),
        (e) => resolve(e)
      );
      xhrFactory.xhr.fireLoad(
        400,
        JSON.stringify({ error: 'Failed to parse file' })
      );
    });
    expect(String(err)).toBe('Error: Failed to parse file');
  });

  it('rejects with "HTTP <status>" when the error body is not JSON', async () => {
    const handle = uploadFile(makeFile('e.md'));
    const err = await new Promise<unknown>((resolve) => {
      handle.promise.then(
        () => resolve(null),
        (e) => resolve(e)
      );
      xhrFactory.xhr.fireLoad(502, 'Bad Gateway');
    });
    expect(String(err)).toBe('Error: HTTP 502');
  });

  it('rejects with "Network error" on the XHR error event', async () => {
    const handle = uploadFile(makeFile('f.md'));
    const err = await new Promise<unknown>((resolve) => {
      handle.promise.then(
        () => resolve(null),
        (e) => resolve(e)
      );
      xhrFactory.xhr.fireError();
    });
    expect(String(err)).toBe('Error: Network error');
  });

  it('aborts the in-flight XHR when the AbortSignal fires', async () => {
    const ac = new AbortController();
    const handle = uploadFile(makeFile('g.md'), undefined, ac.signal);

    const err = await new Promise<unknown>((resolve) => {
      handle.promise.then(
        () => resolve(null),
        (e) => resolve(e)
      );
      ac.abort();
      // After abort, the service should have called xhr.abort(), which
      // (in our fake) fires the `abort` event and rejects the promise.
      // Give microtasks a chance to drain.
    });
    expect(String(err)).toBe('Error: aborted');
  });

  it('handle.abort() rejects with "aborted"', async () => {
    const handle = uploadFile(makeFile('h.md'));
    const err = await new Promise<unknown>((resolve) => {
      handle.promise.then(
        () => resolve(null),
        (e) => resolve(e)
      );
      handle.abort();
    });
    expect(String(err)).toBe('Error: aborted');
  });
});