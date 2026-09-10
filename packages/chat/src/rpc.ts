/** The JSON transport used by T3 0.0.40 / Effect beta.103. */
type Pending = {
  next?: (value: unknown) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export function rpcError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return new Error(record.message);
    for (const key of ['error', 'defect', 'cause']) if (record[key]) return rpcError(record[key]);
    if (Array.isArray(value)) return rpcError(value[0]);
  }
  return new Error(JSON.stringify(value) ?? 'T3 request failed');
}

export class T3Rpc {
  private socket: WebSocket;
  private pending = new Map<string, Pending>();
  private serial = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongAt = Date.now();
  readonly opened: Promise<void>;

  constructor(url: string, onClose: (error: Error) => void) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('T3 connection timed out')); this.close(); }, 15_000);
      this.socket.onopen = () => {
        clearTimeout(timer);
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.pongAt > 45_000) this.close();
          else this.send({ _tag: 'Ping' });
        }, 15_000);
        resolve();
      };
      this.socket.onerror = () => reject(new Error('T3 connection failed'));
      this.socket.onclose = () => {
        clearTimeout(timer);
        clearInterval(this.heartbeat);
        const error = new Error('T3 disconnected. Reconnecting…');
        reject(error);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        this.pending.clear();
        onClose(error);
      };
    });
    this.socket.onmessage = (event) => {
      try {
        const decoded = JSON.parse(String(event.data));
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message._tag === 'Defect') throw rpcError(message.defect);
          if (message._tag === 'Pong') { this.pongAt = Date.now(); continue; }
          if (message._tag === 'Ping') { this.send({ _tag: 'Pong' }); continue; }
          const id = String(message.requestId);
          const entry = this.pending.get(id);
          if (!entry) continue;
          if (message._tag === 'Chunk') {
            for (const value of message.values) entry.next?.(value);
            this.send({ _tag: 'Ack', requestId: id });
          } else if (message._tag === 'Exit') {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            if (message.exit._tag === 'Success') entry.resolve(message.exit.value);
            else entry.reject(rpcError(message.exit.cause));
          }
        }
      } catch (error) { onClose(rpcError(error)); this.close(); }
    };
  }

  private send(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  call<T>(tag: string, payload: unknown): Promise<T> {
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('T3 is not connected')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ _tag: 'Interrupt', requestId: id });
        reject(new Error('T3 request timed out. Its outcome may be pending; refresh before retrying.'));
      }, 30_000);
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
      this.send({ _tag: 'Request', id, tag, payload, headers: [] });
    });
  }

  subscribe<T>(tag: string, payload: unknown, next: (value: T) => void, fail: (error: Error) => void): () => void {
    const id = String(++this.serial);
    this.pending.set(id, { next: next as Pending['next'], resolve: () => {}, reject: fail });
    this.send({ _tag: 'Request', id, tag, payload, headers: [] });
    return () => { this.pending.delete(id); this.send({ _tag: 'Interrupt', requestId: id }); };
  }

  close() { clearInterval(this.heartbeat); this.socket.close(); }
}
