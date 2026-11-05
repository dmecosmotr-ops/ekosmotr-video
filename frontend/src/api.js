let csrfToken = null;
let onUnauthorized = () => {};

export function configureSession(token, unauthorized) {
  csrfToken = token;
  if (unauthorized) onUnauthorized = unauthorized;
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api${path}`, {
    ...options,
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') onUnauthorized();
    const error = new Error(payload.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export function query(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  });
  return search.size ? `?${search}` : '';
}
