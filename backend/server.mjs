import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { closePilotServer } from './live.mjs';
import { loadConfig } from './config.mjs';

// Validate configuration and bootstrap before accepting any network requests.
const { host, port, ...options } = loadConfig();
const app = createApp(options);
const server = createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', error => { console.error(`Pilot server could not start (${error.code || 'ERROR'})`); process.exitCode = 1; app.close(); });
server.listen(port, host, () => console.log(`Camera pilot: ${options.deploymentConfig.mode === 'server'
  ? options.deploymentConfig.publicOrigin : `http://${host.includes(':') ? `[${host}]` : host}:${port}`}`));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await closePilotServer(app, server);
  process.exit(0);
});
