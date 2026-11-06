const canonicalIds = ids => [...new Set(ids || [])].sort();
const sameIds = (left, right) => JSON.stringify(canonicalIds(left)) === JSON.stringify(canonicalIds(right));

// A profile-only edit must not accidentally become a new grant of permissions.
export function buildUserMutation(target, form, stationIds, cameraIds, microphoneStationIds) {
  if (!target) {
    const body = { ...form, stationIds: [...stationIds], cameraIds: [...cameraIds] };
    if (microphoneStationIds !== undefined) body.microphoneStationIds = canonicalIds(microphoneStationIds);
    return body;
  }
  const body = {};
  for (const field of ['name', 'email', 'role', 'active']) {
    if (form[field] !== target[field]) body[field] = form[field];
  }
  if (form.password) body.password = form.password;
  if (!sameIds(stationIds, target.stationIds)) body.stationIds = canonicalIds(stationIds);
  if (!sameIds(cameraIds, target.cameraIds)) body.cameraIds = canonicalIds(cameraIds);
  if (microphoneStationIds !== undefined && !sameIds(microphoneStationIds, target.assignedMicrophoneStationIds ?? target.microphoneStationIds)) {
    body.microphoneStationIds = canonicalIds(microphoneStationIds);
  }
  return body;
}
