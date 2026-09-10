"use node";

import { Impit } from "impit";
import { parseBuffer } from "music-metadata";
import { parse } from "node-html-parser";
import type { DiscoveredCatalogItem } from "../catalog_types";
import {
  fetchBytes,
  type ProviderFetch,
  ProviderRequestError,
  validateRemoteUrl,
} from "./http";
import type { MediaProvider } from "./types";

const ORIGIN = "https://www.myinstants.com";
const HTML_POLICY = {
  hosts: ["www.myinstants.com"],
  maxBytes: 2_000_000,
};
const MEDIA_HOSTS = ["www.myinstants.com", "myinstants.com"];
const SOURCE_ID = /^[A-Za-z0-9_-]{1,240}$/;
const SEARCH_RESULT_PATH = /^\/en\/instant\/([A-Za-z0-9_-]{1,240})\/?$/;
const myinstantsClient = new Impit({
  browser: "chrome142",
  followRedirects: false,
  maxRedirects: 0,
  timeout: 30_000,
});

function normalizedHeaders(value: unknown): Headers {
  if (value instanceof Headers) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error("MyInstants returned invalid response headers");
  }
  const headers = new Headers();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error("MyInstants returned invalid response headers");
    }
    headers.append(entry[0], entry[1]);
  }
  return headers;
}

const myinstantsFetch: ProviderFetch = async (input, init) => {
  const response = await myinstantsClient.fetch(input.href, {
    method: "GET",
    redirect: "manual",
    signal: init?.signal ?? undefined,
  });
  // impit currently types headers as Headers but returns header tuples at runtime.
  return new Response(response.body, {
    headers: normalizedHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
};

async function fetchMyInstantsHtml(path: string): Promise<string> {
  const bytes = await fetchBytes(
    `${ORIGIN}${path}`,
    HTML_POLICY,
    {},
    myinstantsFetch
  );
  return new TextDecoder().decode(bytes);
}

export function parseMyInstantsSearchHtml(
  body: string
): DiscoveredCatalogItem[] {
  const document = parse(body);
  const results: DiscoveredCatalogItem[] = [];
  const seen = new Set<string>();
  for (const instant of document.querySelectorAll(".instant")) {
    const link = instant.querySelector("a.instant-link");
    const href = link?.getAttribute("href");
    const title = link?.text.trim();
    const match = href ? SEARCH_RESULT_PATH.exec(href) : null;
    const externalId = match?.[1];
    if (!(externalId && title) || seen.has(externalId)) {
      continue;
    }
    seen.add(externalId);
    results.push({ externalId, title: title.slice(0, 160) });
    if (results.length === 20) {
      break;
    }
  }
  return results;
}

export function parseMyInstantsDownloadHtml(
  body: string,
  externalId: string
): { url: string; description?: string } {
  const document = parse(body);
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  const expectedPath = `/en/instant/${externalId}/`;
  if (!canonical || new URL(canonical, ORIGIN).pathname !== expectedPath) {
    throw new Error("MyInstants returned a different sound");
  }
  const mediaPath = document
    .querySelector("button#instant-page-button-element")
    ?.getAttribute("data-url");
  if (!mediaPath) {
    throw new Error("MyInstants returned an invalid sound");
  }
  const url = validateRemoteUrl(new URL(mediaPath, ORIGIN).href, MEDIA_HOSTS);
  if (
    !(
      url.pathname.startsWith("/media/sounds/") && url.pathname.endsWith(".mp3")
    )
  ) {
    throw new Error("MyInstants returned an unsupported audio URL");
  }
  return {
    url: url.href,
    description: document
      .querySelector("div#instant-page-description p")
      ?.text.trim()
      .slice(0, 1000),
  };
}

export const myinstantsProvider: MediaProvider = {
  kind: "sfx",
  async search(query) {
    try {
      return parseMyInstantsSearchHtml(
        await fetchMyInstantsHtml(
          `/en/search/?name=${encodeURIComponent(query)}`
        )
      );
    } catch (error) {
      // MyInstants returns HTTP 404 for a search with no matching sounds.
      if (error instanceof ProviderRequestError && error.status === 404) {
        return [];
      }
      throw error;
    }
  },
  async resolve(externalId) {
    if (!SOURCE_ID.test(externalId)) {
      throw new Error("Invalid MyInstants source id");
    }
    const result = parseMyInstantsDownloadHtml(
      await fetchMyInstantsHtml(`/en/instant/${externalId}/`),
      externalId
    );
    const bytes = await fetchBytes(
      result.url,
      {
        hosts: MEDIA_HOSTS,
        maxBytes: 20_000_000,
      },
      {},
      myinstantsFetch
    );
    const metadata = await parseBuffer(
      bytes,
      { mimeType: "audio/mpeg" },
      { duration: true }
    );
    const duration = metadata.format.duration;
    if (
      metadata.format.container !== "MPEG" ||
      !duration ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600
    ) {
      throw new Error("MyInstants did not return playable MP3 audio");
    }
    return {
      bytes,
      extension: "mp3",
      mimeType: "audio/mpeg",
      mediaKind: "audio",
      durationUs: Math.round(duration * 1_000_000),
      description: result.description,
    };
  },
};
