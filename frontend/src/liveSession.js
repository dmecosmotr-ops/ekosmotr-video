const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

function endpoints(cameraId, ticket) {
  if (!cameraId || !ticket || typeof ticket.sessionId !== 'string' || !SESSION_ID.test(ticket.sessionId)) return null;
  const stopUrl = `/api/cameras/${encodeURIComponent(cameraId)}/live/${encodeURIComponent(ticket.sessionId)}`;
  return ticket.stopUrl === stopUrl ? { stopUrl, streamUrl: `${stopUrl}/stream` } : null;
}

export function validLiveTicket(cameraId, ticket) {
  const expected = endpoints(cameraId, ticket);
  return Boolean(expected && ticket.streamUrl === expected.streamUrl);
}

// The controller owns asynchronous tickets. A late POST response must be stopped
// even after the viewer has closed, and must never resurrect an old player.
export function createLiveController({ cameraId, request, onState }) {
  let version = 0, disposed = false, activeTicket = null, phase = 'idle';
  const publish = (next, error = '') => {
    phase = next;
    if (!disposed) onState({ phase, error, ticket: activeTicket });
  };
  const release = async ticket => {
    const expected = endpoints(cameraId, ticket);
    if (!expected) return;
    try { await request(expected.stopUrl.slice(4), { method: 'DELETE', keepalive: true }); }
    catch { /* Closing the HTTP video connection is the server-side fallback. */ }
  };
  return {
    async start() {
      if (disposed || !cameraId || ['starting', 'connecting', 'playing', 'stopping'].includes(phase)) return;
      const current = ++version;
      publish('starting');
      let ticket;
      try {
        ticket = await request(`/cameras/${encodeURIComponent(cameraId)}/live`, { method: 'POST' });
        if (!validLiveTicket(cameraId, ticket)) {
          await release(ticket);
          throw new Error('Сервис вернул некорректный адрес видеопотока. Повторите подключение.');
        }
        if (disposed || current !== version) { await release(ticket); return; }
        activeTicket = ticket;
        publish('connecting');
      } catch (failure) {
        if (!disposed && current === version) publish('error', failure.message || 'Не удалось подключиться к камере. Повторите попытку.');
      }
    },
    playing(sessionId) {
      if (!disposed && activeTicket?.sessionId === sessionId) publish('playing');
    },
    async stop() {
      if (phase === 'stopping') return;
      version++;
      const previous = activeTicket;
      activeTicket = null;
      publish('stopping');
      await release(previous);
      publish('idle');
    },
    async fail(message, sessionId) {
      if (disposed || !activeTicket || sessionId && activeTicket.sessionId !== sessionId) return;
      version++;
      const previous = activeTicket;
      activeTicket = null;
      publish('error', message);
      await release(previous);
    },
    dispose() {
      if (disposed) return;
      disposed = true; version++;
      const previous = activeTicket;
      activeTicket = null;
      void release(previous);
    },
  };
}
