// Internal liveness only. It does not assert camera/network readiness.
try {
  const response = await fetch('http://127.0.0.1:3210/api/health', {
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
