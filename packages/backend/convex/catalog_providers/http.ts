export interface FetchPolicy {
  hosts: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
}

export type ProviderFetch = (
  input: URL,
  init: RequestInit
) => Promise<Response>;

export class ProviderRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Provider request failed (${status})`);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}

export function validateRemoteUrl(
  value: string,
  hosts: readonly string[]
): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname)
  ) {
    throw new Error("Provider returned an unsupported URL");
  }
  return url;
}

/** Bound the body while reading; Content-Length is neither required nor trusted. */
export async function fetchBytes(
  value: string,
  policy: FetchPolicy,
  init: RequestInit = {},
  providerFetch: ProviderFetch = fetch
): Promise<Uint8Array> {
  let url = validateRemoteUrl(value, policy.hosts);
  const signal = AbortSignal.timeout(policy.timeoutMs ?? 30_000);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await providerFetch(url, {
      ...init,
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Provider returned an invalid redirect");
      }
      const next = validateRemoteUrl(new URL(location, url).href, policy.hosts);
      if (init.headers && next.origin !== url.origin) {
        throw new Error("Authenticated cross-origin redirect rejected");
      }
      url = next;
      continue;
    }
    return await readBoundedBody(response, policy.maxBytes);
  }
  throw new Error("Provider returned too many redirects");
}

async function readBoundedBody(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderRequestError(response.status);
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Provider file exceeds the download limit");
  }
  if (!response.body) {
    throw new Error("Provider returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        throw new Error("Provider file exceeds the download limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  if (!size) {
    throw new Error("Provider returned an empty response");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchJson(
  url: string,
  policy: FetchPolicy,
  init?: RequestInit
): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(await fetchBytes(url, policy, init))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
