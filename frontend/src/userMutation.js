const canonicalIds = ids => [...new Set(ids || [])].sort();
const sameIds = (left, right) => JSON.stringify(canonicalIds(left)) === JSON.stringify(canonicalIds(right));

// A profile-only edit must not accidentally become a new grant of permissions.
export function buildUserMutation(target, form, stationIds, cameraIds) {
  if (!target) return { ...form, stationIds: [...stationIds], cameraIds: [...cameraIds] };
  const body = {};
  for (const field of ['name', 'email', 'role', 'active']) {
    if (form[field] !== target[field]) body[field] = form[field];
  }
  if (form.password) body.password = form.password;
  if (!sameIds(stationIds, target.stationIds)) body.stationIds = canonicalIds(stationIds);
  if (!sameIds(cameraIds, target.cameraIds)) body.cameraIds = canonicalIds(cameraIds);
  return body;
}
