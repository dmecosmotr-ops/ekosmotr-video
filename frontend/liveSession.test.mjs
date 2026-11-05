import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveController, validLiveTicket } from './src/liveSession.js';

const camera = 'xiaomi_camera';
const id = 'live-session-12345678';
const ticket = { sessionId: id, streamUrl: `/api/cameras/${camera}/live/${id}/stream`, stopUrl: `/api/cameras/${camera}/live/${id}`, maxDurationSeconds: 600 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('live ticket accepts only this camera and exact same-origin live routes', () => {
  assert.equal(validLiveTicket(camera, ticket), true);
  for (const changed of [
    { streamUrl: 'https://example.com/video.mp4' },
    { streamUrl: '//example.com/video' },
    { streamUrl: '/api/cameras/other/live/live-session-12345678/stream' },
    { stopUrl: '/api/logout' },
    { sessionId: '../secret' },
  ]) assert.equal(validLiveTicket(camera, { ...ticket, ...changed }), false);
});

test('live starts only on request and connecting becomes playing only after video event', async () => {
  const calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: async (...args) => { calls.push(args); return ticket; }, onState: value => views.push(value) });
  assert.equal(calls.length, 0);
  await controller.start();
  assert.equal(calls[0][0], `/cameras/${camera}/live`);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(views.at(-1).phase, 'connecting');
  controller.playing(id);
  assert.equal(views.at(-1).phase, 'playing');
  await controller.stop();
  assert.equal(calls.at(-1)[0], ticket.stopUrl.slice(4));
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.equal(views.at(-1).phase, 'idle');
});

test('stop before pending start completes cleans up the late ticket without showing it', async () => {
  const pending = deferred(), calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: (path, options) => { calls.push([path, options]); return options.method === 'POST' ? pending.promise : Promise.resolve({ ok: true }); }, onState: value => views.push(value) });
  const started = controller.start();
  await controller.stop();
  pending.resolve(ticket);
  await started;
  assert.equal(views.at(-1).phase, 'idle');
  assert.equal(views.some(view => view.ticket), false);
  assert.equal(calls.filter(([, options]) => options.method === 'DELETE').length, 1);
});

test('dispose blocks late state updates and releases pending or active sessions', async () => {
  const pending = deferred(), calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: (path, options) => { calls.push([path, options]); return options.method === 'POST' ? pending.promise : Promise.resolve({ ok: true }); }, onState: value => views.push(value) });
  const started = controller.start();
  controller.dispose();
  const count = views.length;
  pending.resolve(ticket);
  await started;
  assert.equal(views.length, count);
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  controller.playing(id);
  assert.equal(views.length, count);
});

test('playback error releases the session and permits a fresh manual retry', async () => {
  const calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: async (path, options) => { calls.push([path, options]); return ticket; }, onState: value => views.push(value) });
  await controller.start();
  await controller.fail('Не удалось открыть прямой эфир.');
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.equal(views.at(-1).phase, 'error');
  await controller.start();
  assert.equal(views.at(-1).phase, 'connecting');
});

test('duplicate starts do not create concurrent requests and unsafe payload never reaches the player', async () => {
  const pending = deferred(), calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: (path, options) => { calls.push([path, options]); return pending.promise; }, onState: value => views.push(value) });
  const first = controller.start();
  await controller.start();
  assert.equal(calls.length, 1);
  pending.resolve({ ...ticket, streamUrl: 'https://example.com/token-secret' });
  await first;
  assert.equal(views.at(-1).phase, 'error');
  assert.equal(views.at(-1).ticket, null);
  assert.ok(!JSON.stringify(views).includes('token-secret'));
});

test('an error from an old video element cannot stop a newer session', async () => {
  const views = [], calls = [];
  const controller = createLiveController({ cameraId: camera, request: async (path, options) => { calls.push([path, options]); return ticket; }, onState: value => views.push(value) });
  await controller.start();
  await controller.fail('Old video failed', 'old-session-12345678');
  assert.equal(views.at(-1).phase, 'connecting');
  assert.equal(calls.filter(([, options]) => options.method === 'DELETE').length, 0);
  await controller.stop();
});

test('manual restart is blocked until the stop request finishes', async () => {
  const closing = deferred(), calls = [], views = [];
  const controller = createLiveController({ cameraId: camera, request: (path, options) => { calls.push([path, options]); return options.method === 'DELETE' ? closing.promise : Promise.resolve(ticket); }, onState: value => views.push(value) });
  await controller.start();
  const stopped = controller.stop();
  assert.equal(views.at(-1).phase, 'stopping');
  await controller.start();
  assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1);
  closing.resolve({ ok: true });
  await stopped;
  assert.equal(views.at(-1).phase, 'idle');
});
