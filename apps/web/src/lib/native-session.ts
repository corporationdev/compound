import type { CloudAuthOperation, CloudAuthResult } from '@desktop/main-channels';

type SessionTransport = {
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  authUrl: () => Promise<string>;
  request: (data: {
    operation: CloudAuthOperation;
    body?: Record<string, unknown>;
    sessionToken: string | null;
  }) => Promise<CloudAuthResult>;
};

export function createNativeSession(transport: SessionTransport) {
  let queue: Promise<unknown> = Promise.resolve();
  return (operation: CloudAuthOperation, body?: Record<string, unknown>): Promise<unknown> => {
    // Include persistence in the queue so an in-flight refresh cannot restore
    // the saved credential after sign-out. Read storage at execution time.
    const request = queue.then(async () => {
      const key = `compound:${await transport.authUrl()}:native-session`;
      const storage = transport.storage();
      const result = await transport.request({ operation, body, sessionToken: storage.getItem(key) });
      if (result.sessionToken) storage.setItem(key, result.sessionToken);
      else storage.removeItem(key);
      if (result.error) throw new Error(result.error);
      return result.data;
    });
    queue = request.catch(() => {});
    return request;
  };
}
