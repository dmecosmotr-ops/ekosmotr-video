// Matches the diagnostic bridge's H.264 Constrained Baseline / level 2.2 output.
export const liveMseType = 'video/mp4; codecs="avc1.42C016"';

export function supportsLiveMse(MediaSourceClass = globalThis.MediaSource) {
  return Boolean(MediaSourceClass?.isTypeSupported?.(liveMseType));
}

// One authenticated fetch is consumed with backpressure. The browser must not
// reopen a single-use stream through automatic native Range requests.
export function createMsePipeline({ video, url, onError,
  fetchImpl = globalThis.fetch, MediaSourceClass = globalThis.MediaSource,
  createObjectURL = value => URL.createObjectURL(value), revokeObjectURL = value => URL.revokeObjectURL(value),
  maxBufferSeconds = 30 }) {
  const abort = new AbortController();
  const source = new MediaSourceClass();
  const objectUrl = createObjectURL(source);
  const keepSeconds = Math.max(10, Math.min(30, maxBufferSeconds));
  let disposed = false, failed = false, opened = false, reader = null, buffer = null, readerCanceled = false;
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const cancelReader = () => {
    if (readerCanceled || !reader) return;
    readerCanceled = true;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
  };
  const cancel = () => { abort.abort(); cancelReader(); };
  const startPlayback = () => {
    if (disposed || failed) return;
    try { video.play()?.catch?.(() => {}); } catch { /* Native controls remain available. */ }
  };
  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    cancel();
    onError('Не удалось воспроизвести прямой эфир. Соединение прервалось или формат потока недоступен. Повторите подключение.');
  };
  const update = action => new Promise((resolve, reject) => {
    if (disposed || failed) { resolve(); return; }
    const clear = () => {
      buffer.removeEventListener('updateend', finished);
      buffer.removeEventListener('error', errored);
      abort.signal.removeEventListener('abort', canceled);
    };
    const finished = () => { clear(); resolve(); };
    const errored = () => { clear(); reject(new Error('SOURCE_BUFFER_FAILED')); };
    const canceled = () => { clear(); resolve(); };
    buffer.addEventListener('updateend', finished, { once: true });
    buffer.addEventListener('error', errored, { once: true });
    abort.signal.addEventListener('abort', canceled, { once: true });
    try { action(); } catch (error) { clear(); reject(error); }
  });
  const trim = async () => {
    if (disposed || failed || !buffer.buffered.length) return;
    const last = buffer.buffered.end(buffer.buffered.length - 1);
    const first = buffer.buffered.start(0), cutoff = Math.max(0, last - keepSeconds);
    // A paused live viewer cannot retain an unlimited DVR archive. Resume near
    // current live frames after the old window has fallen outside the buffer.
    if (video.currentTime < first - .1 || video.currentTime < cutoff) video.currentTime = Math.max(first, last - 2);
    if (cutoff > first + 1) await update(() => buffer.remove(0, cutoff));
  };
  const open = async () => {
    if (disposed || opened) return;
    opened = true;
    let chunks = 0;
    try {
      buffer = source.addSourceBuffer(liveMseType);
      buffer.addEventListener('error', fail);
      const response = await fetchImpl(url, { credentials: 'same-origin', signal: abort.signal, cache: 'no-store' });
      if (disposed || failed) return;
      if (!response.ok || !response.body?.getReader) throw new Error('LIVE_HTTP_FAILED');
      reader = response.body.getReader();
      while (!disposed && !failed) {
        const item = await reader.read();
        if (disposed || failed) break;
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        chunks++;
        await update(() => buffer.appendBuffer(item.value));
        if (disposed || failed) break;
        await trim();
      }
      if (!disposed && !failed) {
        if (!chunks) throw new Error('EMPTY_LIVE_STREAM');
        if (source.readyState === 'open' && !buffer.updating) source.endOfStream();
      }
    } catch { fail(); }
    finally { complete(); }
  };
  const closed = () => { if (opened && !disposed && !failed && source.readyState !== 'ended') fail(); };
  source.addEventListener('sourceopen', open, { once: true });
  source.addEventListener('sourceclose', closed);
  video.addEventListener('canplay', startPlayback, { once: true });
  video.src = objectUrl;
  return {
    done,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      source.removeEventListener('sourceopen', open);
      source.removeEventListener('sourceclose', closed);
      video.removeEventListener('canplay', startPlayback);
      buffer?.removeEventListener('error', fail);
      try { if (buffer?.updating && source.readyState === 'open') buffer.abort(); } catch { /* Media source already closed. */ }
      video.pause(); video.removeAttribute('src'); video.load();
      revokeObjectURL(objectUrl);
      if (!opened) complete();
    },
  };
}
