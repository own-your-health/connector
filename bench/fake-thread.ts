// test/fake-google.ts on its own thread, for the CPU bench: its file reads,
// hashing and listings are not counted against the connector's thread.

import { parentPort, workerData } from 'node:worker_threads';
import { FakeGoogle } from '../test/fake-google.ts';

const g = new FakeGoogle(workerData.root as string);
parentPort!.on('message', async (m: { id: number; approve?: string; url?: string; method?: string; headers?: [string, string][]; body?: Uint8Array | string }) => {
  if (m.approve !== undefined) return parentPort!.postMessage({ id: m.id, approved: g.approve(m.approve) });
  const res = await g.fetch(m.url!, { method: m.method, headers: m.headers, body: m.body });
  const body = new Uint8Array(await res.arrayBuffer());
  parentPort!.postMessage({ id: m.id, status: res.status, headers: [...res.headers], body }, [body.buffer]);
});
