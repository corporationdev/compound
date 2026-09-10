import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { providerCapabilities } from "../convex/catalog_providers/capabilities";
import {
  fetchBytes,
  validateRemoteUrl,
} from "../convex/catalog_providers/http";
import {
  parseMyInstantsDownloadHtml,
  parseMyInstantsSearchHtml,
} from "../convex/catalog_providers/myinstants";
import { getProvider } from "../convex/catalog_providers/registry";
import {
  parseYouTubeSearch,
  youtubeProvider,
} from "../convex/catalog_providers/youtube";

const fetchTarget: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = globalThis;
afterEach(() => mock.restore());
const host = "www.myinstants.com";
const sound = {
  id: "whoosh-sfx-32736",
  title: "  Whoosh  ",
  mp3: "https://www.myinstants.com/media/sounds/whoosh.mp3",
};
const searchResult = (id: string, title: string) => `
  <div class="instant">
    <button class="small-button" onclick="play('/media/sounds/${id}.mp3')"></button>
    <a href="/en/instant/${id}/" class="instant-link">${title}</a>
  </div>`;

const detailHtml = (id: string, mediaPath = "/media/sounds/whoosh.mp3") => `
  <link rel="canonical" href="https://www.myinstants.com/en/instant/${id}/">
  <button id="instant-page-button-element" data-url="${mediaPath}"></button>
  <div id="instant-page-description"><p>Fast &amp; airy</p></div>`;

test("MyInstants parses direct search HTML, decodes titles, deduplicates, and bounds results", () => {
  const items = parseMyInstantsSearchHtml(
    `${searchResult(sound.id, "Whoosh &amp; Boom")}${searchResult(sound.id, "Duplicate")}${searchResult("../bad", "Bad")}`
  );
  expect(items).toEqual([{ externalId: sound.id, title: "Whoosh & Boom" }]);
  expect(
    parseMyInstantsSearchHtml(
      Array.from({ length: 50 }, (_, index) =>
        searchResult(`sound-${index}`, `Sound ${index}`)
      ).join("")
    )
  ).toHaveLength(20);
});

test("MyInstants parses a direct detail page and rejects wrong or unsafe media", () => {
  expect(parseMyInstantsDownloadHtml(detailHtml(sound.id), sound.id)).toEqual({
    url: sound.mp3,
    description: "Fast & airy",
  });
  expect(() =>
    parseMyInstantsDownloadHtml(detailHtml(sound.id), "other-sound")
  ).toThrow("different sound");
  expect(() =>
    parseMyInstantsDownloadHtml(
      detailHtml(sound.id, "https://evil.test/sound.mp3"),
      sound.id
    )
  ).toThrow("unsupported URL");
  expect(() =>
    parseMyInstantsDownloadHtml(detailHtml(sound.id, "/index.html"), sound.id)
  ).toThrow("unsupported audio");
});

test("provider URLs reject credentials, private hosts, HTTP, and nonstandard ports", () => {
  for (const url of [
    "http://www.myinstants.com/a",
    "https://127.0.0.1/a",
    "https://www.myinstants.com.evil.test/a",
    "https://x:y@www.myinstants.com/a",
    "https://www.myinstants.com:8443/a",
  ]) {
    expect(() => validateRemoteUrl(url, [host])).toThrow();
  }
});

test("YouTube discovery filters unsupported and excessive durations without artist or thumbnail fields", () => {
  const item = {
    type: "video",
    videoId: "abcdefghijk",
    title: "Song",
    lengthText: "3:15",
    channelTitle: "ignored",
    thumbnail: "ignored",
  };
  expect(
    parseYouTubeSearch([
      item,
      item,
      { ...item, videoId: "other123456", lengthText: "2:00:00" },
    ])
  ).toEqual([
    { externalId: "abcdefghijk", title: "Song", durationUs: 195_000_000 },
  ]);
});

test("download enforces streaming limit without Content-Length", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation(
    (async () => new Response(new Uint8Array(12)))
  );
  await expect(
    fetchBytes(sound.mp3, { hosts: [host], maxBytes: 10 })
  ).rejects.toThrow("download limit");
});

test("download rejects hostile redirect before fetching its destination", async () => {
  const fetchMock = spyOn(fetchTarget, "fetch").mockImplementation((async () =>
    Response.redirect("https://127.0.0.1/secret", 302)
  ));
  await expect(
    fetchBytes(sound.mp3, { hosts: [host], maxBytes: 10 })
  ).rejects.toThrow("unsupported URL");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("download never forwards authorization to another allowed origin", async () => {
  spyOn(fetchTarget, "fetch").mockImplementation((async () =>
    Response.redirect("https://myinstants.com/media/sounds/a.mp3", 302)
  ));
  await expect(
    fetchBytes(
      sound.mp3,
      { hosts: [host, "myinstants.com"], maxBytes: 10 },
      { headers: { Authorization: "test-only" } }
    )
  ).rejects.toThrow("cross-origin");
});

test("download accepts bounded bytes and follows safe same-host redirects", async () => {
  const fetchMock = spyOn(fetchTarget, "fetch");
  fetchMock.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "/media/sounds/new.mp3" },
    })
  );
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
  expect(await fetchBytes(sound.mp3, { hosts: [host], maxBytes: 10 })).toEqual(
    new Uint8Array([1, 2, 3])
  );
});

test("MyInstants empty search HTML is empty and provider request failures surface", async () => {
  expect(parseMyInstantsSearchHtml("<html><body></body></html>")).toEqual([]);
  const fetchMock = spyOn(fetchTarget, "fetch");
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(
    fetchBytes(sound.mp3, { hosts: [host], maxBytes: 10 })
  ).rejects.toThrow("503");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("artwork capability matches the provider implementation", () => {
  for (const provider of ["youtube", "myinstants"] as const) {
    expect(providerCapabilities[provider].artwork).toBe(
      Boolean(getProvider(provider).resolveArtwork)
    );
  }
});

test("YouTube artwork downloads independently without starting an audio job", async () => {
  const bytes = new Uint8Array([255, 216, 255, 224]);
  const fetchMock = spyOn(fetchTarget, "fetch").mockResolvedValue(
    new Response(bytes)
  );
  const artwork = await youtubeProvider.resolveArtwork?.("abcdefghijk");
  expect(artwork?.mimeType).toBe("image/jpeg");
  expect(artwork?.bytes).toEqual(bytes);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
  );
});

test("YouTube artwork rejects non-images and invalid source IDs", async () => {
  const fetchMock = spyOn(fetchTarget, "fetch").mockResolvedValue(
    new Response("not an image")
  );
  await expect(youtubeProvider.resolveArtwork?.("abcdefghijk")).rejects.toThrow(
    "JPEG"
  );
  await expect(youtubeProvider.resolveArtwork?.("../bad")).rejects.toThrow(
    "source id"
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
