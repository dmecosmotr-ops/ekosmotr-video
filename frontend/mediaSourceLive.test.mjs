import test from 'node:test';
import assert from 'node:assert/strict';
import { createMsePipeline, liveMseType } from './src/mediaSourceLive.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class FakeBuffer extends EventTarget {
  updating = false;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  appended = [];
  removed = [];
  appendBuffer(value) { this.appended.push(value); this.updating = true; }
  remove(from, to) { this.removed.push([from, to]); this.updating = true; }
  finish() { this.updating = false; this.dispatchEvent(new Event('updateend')); }
  abort() { this.updating = false; }
}
class FakeSource extends EventTarget {
  static instances = [];
  static isTypeSupported(type) { return type === liveMseType; }
  readyState = 'closed';
  buffer = new FakeBuffer();
  constructor() { super(); FakeSource.instances.push(this); }
  addSourceBuffer(type) { assert.equal(type, liveMseType); return this.buffer; }
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
  endOfStream() { this.readyState = 'ended'; }
}
function setup(reader, fetchOverride) {
  const errors = [], revoked = [], requests = [];
  const video = Object.assign(new EventTarget(), { src: '', currentTime: 0, playCount: 0, pause() {}, load() {}, removeAttribute() { this.src = ''; }, play() { this.playCount++; return Promise.resolve(); } });
  const pipeline = createMsePipeline({ video, url: '/api/cameras/cam/live/valid-session/stream', MediaSourceClass: FakeSource,
    createObjectURL: () => 'blob:local-test', revokeObjectURL: url => revoked.push(url),
    fetchImpl: async (...args) => { requests.push(args); return fetchOverride ? fetchOverride(...args) : { ok: true, body: { getReader: () => reader } }; },
    onError: message => errors.push(message) });
  const source = FakeSource.instances.at(-1);
  source.open();
  return { pipeline, source, video, errors, revoked, requests };
}

test('MSE fetches same-origin once and waits for updateend before reading more bytes', async () => {
  let reads = 0;
  const reader = { read: async () => ++reads <= 2 ? { value: new Uint8Array([reads]), done: false } : { done: true }, cancel() {} };
  const { pipeline, source, requests, errors, video } = setup(reader);
  await tick();
  assert.equal(reads, 1);
  assert.equal(source.buffer.appended.length, 1);
  assert.equal(requests[0][1].credentials, 'same-origin');
  assert.equal(requests[0][1].signal.aborted, false);
  source.buffer.finish(); await tick();
  assert.equal(reads, 2);
  source.buffer.finish(); await pipeline.done;
  video.dispatchEvent(new Event('canplay'));
  video.dispatchEvent(new Event('canplay'));
  assert.equal(video.playCount, 1, 'later chunks or canplay events must not undo a manual pause');
  assert.equal(reads, 3);
  assert.equal(requests.length, 1);
  assert.equal(source.readyState, 'ended');
  assert.deepEqual(errors, []);
  pipeline.dispose();
});

test('disposing cancels a pending read, aborts fetch and never appends its late chunk', async () => {
  const pending = deferred(); let canceled = 0;
  const { pipeline, source, video, revoked, requests, errors } = setup({ read: () => pending.promise, cancel() { canceled++; return Promise.resolve(); } });
  await tick();
  pipeline.dispose();
  pending.resolve({ done: false, value: new Uint8Array([1, 2]) });
  await pipeline.done;
  assert.equal(canceled, 1);
  assert.equal(requests[0][1].signal.aborted, true);
  assert.equal(source.buffer.appended.length, 0);
  assert.equal(video.src, '');
  assert.deepEqual(revoked, ['blob:local-test']);
  assert.deepEqual(errors, []);
});

test('buffer retains only the recent live window before receiving the next chunk', async () => {
  let reads = 0;
  const { pipeline, source, video } = setup({ read: async () => ++reads === 1 ? { value: new Uint8Array([1]), done: false } : { done: true }, cancel() {} });
  await tick();
  source.buffer.buffered = { length: 1, start: () => 0, end: () => 80 };
  video.currentTime = 5;
  source.buffer.finish(); await tick();
  assert.deepEqual(source.buffer.removed, [[0, 50]]);
  assert.equal(reads, 1);
  assert.equal(video.currentTime, 78);
  source.buffer.finish(); await pipeline.done;
  pipeline.dispose();
});

test('HTTP denial and source buffer error stop the reader without exposing upstream details', async () => {
  const denied = setup(null, async () => ({ ok: false, status: 403 }));
  await denied.pipeline.done;
  assert.equal(denied.errors.length, 1);
  assert.equal(denied.source.buffer.appended.length, 0);
  denied.pipeline.dispose();
  let canceled = 0;
  const failed = setup({ read: async () => ({ done: false, value: new Uint8Array([1]) }), cancel() { canceled++; return Promise.resolve(); } });
  await tick();
  failed.source.buffer.dispatchEvent(new Event('error'));
  await failed.pipeline.done;
  assert.equal(failed.errors.length, 1);
  assert.equal(canceled, 1);
  assert.equal(failed.source.buffer.appended.length, 1);
  failed.pipeline.dispose();
});

test('disposing during a pending fetch or before sourceopen cannot attach a reader', async () => {
  const pending = deferred(); let acquired = 0;
  const active = setup(null, () => pending.promise);
  active.pipeline.dispose();
  pending.resolve({ ok: true, body: { getReader() { acquired++; return {}; } } });
  await active.pipeline.done;
  assert.equal(acquired, 0);
  assert.equal(active.errors.length, 0);
});
