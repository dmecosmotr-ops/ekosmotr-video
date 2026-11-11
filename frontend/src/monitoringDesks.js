const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const deskName = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 60) : '';
const cameraIds = value => Array.isArray(value) ? [...new Set(value.filter(validId))] : [];
const storageKey = userId => `ekosmotr.monitoring.desks.v2.${encodeURIComponent(userId)}`;
const emptyDesks = ids => ({ activeId: null, desks: [], draftCameraIds: cameraIds(ids) });

function normalize(state) {
  if (!Array.isArray(state?.desks)) return null;
  const ids = new Set();
  const desks = [];
  for (const item of state.desks) {
    const name = deskName(item?.name);
    if (!validId(item?.id) || !name || ids.has(item.id)) continue;
    ids.add(item.id);
    desks.push({ id: item.id, name, cameraIds: cameraIds(item.cameraIds) });
  }
  return {
    activeId: ids.has(state.activeId) ? state.activeId : (desks[0]?.id ?? null),
    desks,
    draftCameraIds: desks.length ? [] : cameraIds(state.draftCameraIds),
  };
}

export function loadMonitorDesks(storage, userId) {
  if (!storage || !userId) return emptyDesks();
  try {
    const saved = normalize(JSON.parse(storage.getItem(storageKey(userId))));
    if (saved) return saved;
  } catch { /* An older saved selection may still be readable. */ }
  try {
    return emptyDesks(JSON.parse(storage.getItem(`ekosmotr.monitoring.v1.${encodeURIComponent(userId)}`)));
  } catch { return emptyDesks(); }
}

export function saveMonitorDesks(storage, userId, state) {
  if (!storage || !userId) return;
  const saved = normalize(state);
  if (!saved) return;
  try { storage.setItem(storageKey(userId), JSON.stringify(saved)); }
  catch { /* Browser storage may be disabled or full. */ }
}

export function sanitizeMonitorDesks(state, allowedIds) {
  const allowed = new Set(allowedIds);
  const desks = state.desks.map(desk => {
    const visible = desk.cameraIds.filter(id => allowed.has(id));
    return visible.length === desk.cameraIds.length ? desk : { ...desk, cameraIds: visible };
  });
  const draftCameraIds = state.draftCameraIds.filter(id => allowed.has(id));
  const unchanged = draftCameraIds.length === state.draftCameraIds.length && desks.every((desk, index) => desk === state.desks[index]);
  return unchanged ? state : { ...state, desks, draftCameraIds };
}

export function addMonitorDesk(state, input) {
  const name = deskName(input);
  if (!name) return state;
  const id = globalThis.crypto.randomUUID();
  return { activeId: id, desks: [...state.desks, { id, name, cameraIds: state.draftCameraIds }], draftCameraIds: [] };
}

export function renameMonitorDesk(state, id, input) {
  const name = deskName(input);
  if (!name || !state.desks.some(desk => desk.id === id && desk.name !== name)) return state;
  return { ...state, desks: state.desks.map(desk => desk.id === id ? { ...desk, name } : desk) };
}

export function removeMonitorDesk(state, id) {
  const index = state.desks.findIndex(desk => desk.id === id);
  if (index < 0) return state;
  const desks = state.desks.filter(desk => desk.id !== id);
  const activeId = state.activeId === id ? (desks[Math.min(index, desks.length - 1)]?.id ?? null) : state.activeId;
  return { ...state, activeId, desks };
}

export function selectMonitorDesk(state, id) {
  if (id === state.activeId || !state.desks.some(desk => desk.id === id)) return state;
  return { ...state, activeId: id };
}

export function setMonitorDeskCameras(state, ids) {
  const selected = cameraIds(ids);
  if (state.activeId === null) return { ...state, draftCameraIds: selected };
  return { ...state, desks: state.desks.map(desk => desk.id === state.activeId ? { ...desk, cameraIds: selected } : desk) };
}
