/**
 * Measures CDP traffic in both directions without modifying upstream source.
 *
 * Wraps puppeteer-core's internal `Connection.prototype._rawSend` (to learn
 * which method each request id belongs to) and `onMessage` (to count the
 * bytes of every inbound message and the request->response latency). This is
 * where screenshot/beginFrame payloads (base64 JPEG/PNG) and drawElement
 * `Runtime.callFunctionOn` results cross from Chrome into Node, so the byte
 * totals are the measured "readback over CDP" volume.
 *
 * Every puppeteer-core copy in the upstream install is patched, because
 * engine and producer may resolve different versions.
 */
import { createRequire } from "node:module";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface MethodTraffic {
  calls: number;
  /** Response bytes (Chrome -> Node). */
  bytes: number;
  /** Request bytes (Node -> Chrome), e.g. pixels pushed into the page. */
  sentBytes: number;
  latenciesMs: number[];
}

export interface CdpTapSnapshot {
  inboundBytes: number;
  outboundBytes: number;
  eventBytes: number;
  byMethod: Record<string, MethodTraffic>;
}

const state = {
  inboundBytes: 0,
  outboundBytes: 0,
  eventBytes: 0,
  byMethod: new Map<string, MethodTraffic>(),
};
const pending = new WeakMap<object, Map<number, { method: string; t0: number }>>();
const RESPONSE_ID = /^\{"id":(\d+),/;
const EVENT_METHOD = /^\{"method":"([^"]+)"/;
let installed: string[] = [];

function bucket(method: string): MethodTraffic {
  let b = state.byMethod.get(method);
  if (!b) {
    b = { calls: 0, bytes: 0, sentBytes: 0, latenciesMs: [] };
    state.byMethod.set(method, b);
  }
  return b;
}

function patch(Connection: any): void {
  const proto = Connection.prototype;
  if (proto.__turboTapped) return;
  proto.__turboTapped = true;
  const rawSend = proto._rawSend;
  proto._rawSend = function (callbacks: any, method: string, params: unknown, sessionId: unknown, options: unknown) {
    const conn = this;
    const proxy = {
      create: (label: string, timeout: number, fn: (id: number) => void) =>
        callbacks.create(label, timeout, (id: number) => {
          let m = pending.get(conn);
          if (!m) pending.set(conn, (m = new Map()));
          m.set(id, { method, t0: performance.now() });
          const sent = JSON.stringify(params ?? {}).length + method.length;
          state.outboundBytes += sent;
          bucket(method).sentBytes += sent;
          fn(id);
        }),
    };
    return rawSend.call(this, proxy, method, params, sessionId, options);
  };
  const onMessage = proto.onMessage;
  proto.onMessage = function (message: string) {
    state.inboundBytes += message.length;
    const head = message.slice(0, 160);
    const idMatch = RESPONSE_ID.exec(head);
    if (idMatch) {
      const req = pending.get(this)?.get(Number(idMatch[1]));
      if (req) {
        pending.get(this)!.delete(Number(idMatch[1]));
        const b = bucket(req.method);
        b.calls++;
        b.bytes += message.length;
        b.latenciesMs.push(performance.now() - req.t0);
      }
    } else {
      // Session-scoped responses start with {"id":..} too; anything else is an event.
      const ev = EVENT_METHOD.exec(head);
      if (ev) state.eventBytes += message.length;
    }
    return onMessage.call(this, message);
  };
}

/** Patch every puppeteer-core copy found under the upstream bun store. */
export async function installCdpTap(upstreamRoot: string): Promise<string[]> {
  const store = join(upstreamRoot, "node_modules", ".bun");
  const dirs = existsSync(store) ? readdirSync(store).filter((d) => d.startsWith("puppeteer-core@")) : [];
  for (const d of dirs) {
    const file = join(store, d, "node_modules", "puppeteer-core", "lib", "puppeteer", "cdp", "Connection.js");
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    patch(mod.Connection);
    installed.push(d);
  }
  // Also patch whatever `puppeteer-core` the engine package itself resolves to.
  try {
    const req = createRequire(join(upstreamRoot, "packages", "engine", "package.json"));
    const main = req.resolve("puppeteer-core");
    const file = join(main, "..", "cdp", "Connection.js");
    if (existsSync(file)) patch((await import(pathToFileURL(file).href)).Connection);
  } catch {
    // Resolution failure only means the store scan above is the sole source.
  }
  return installed;
}

export function resetCdpTap(): void {
  state.inboundBytes = 0;
  state.outboundBytes = 0;
  state.eventBytes = 0;
  state.byMethod.clear();
}

export function snapshotCdpTap(): CdpTapSnapshot {
  const byMethod: CdpTapSnapshot["byMethod"] = {};
  for (const [m, b] of state.byMethod) byMethod[m] = { ...b, latenciesMs: [...b.latenciesMs] };
  return {
    inboundBytes: state.inboundBytes,
    outboundBytes: state.outboundBytes,
    eventBytes: state.eventBytes,
    byMethod,
  };
}
