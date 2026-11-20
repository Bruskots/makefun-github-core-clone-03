import { createApp } from './server.ts';
import { Forge } from './store.ts';

// The entrypoint: start the forge, tell the suite where it listens, and stay
// up until the suite says the trial is over.
//
//   1. Bind an ephemeral port (listen(0)); never 8080, which the suite owns.
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   4. Shut the server down and exit 0.
//
// The forge itself is in-memory and deterministic; the only state that
// leaves this process is the HTTP answers the suite reads.

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no suite to register with\n');
  process.exit(1);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Back off between retries, doubling from 250 ms up to 2 s. */
function backoff(attempt: number): number {
  return Math.min(2000, 250 * 2 ** Math.min(attempt, 3));
}

async function postPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      response = null;
    }
    if (response !== null && (response.status === 200 || response.status === 409)) return;
    if (response !== null && (response.status === 400 || response.status === 405)) {
      throw new Error(`register refused the port with HTTP ${response.status}`);
    }
    await wait(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite is not answering yet; keep polling.
    }
    await wait(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const forge = new Forge();
  const server = createApp(forge, TOKEN);
  // A SIGTERM/SIGINT from the harness stops the poll loop cleanly instead
  // of leaving the process hanging on a half-open connection. Draining
  // keep-alive connections first: server.close() alone waits for them.
  const shutdown = (): void => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await postPort(address.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitUntilDone();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
