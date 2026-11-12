import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { lookup } from "node:dns";
import { isNewsletterUrl } from "./newsletter-urls.js";

const publicAddress = (address) => isNewsletterUrl(`http://${address.includes(":") ? `[${address}]` : address}/`);
// Resolve and validate the actual connection address, with no unchecked redirects.
export function probeAsset(raw, kind) {
  if (!isNewsletterUrl(raw)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const url = new URL(raw);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "HEAD",
      headers: { "user-agent": "digest-collector/1.0" },
      lookup(host, options, callback) {
        lookup(host, options, (error, addresses, family) => {
          const safe = !error && (Array.isArray(addresses)
            ? addresses.length > 0 && addresses.every(({ address }) => publicAddress(address))
            : publicAddress(addresses));
          if (!safe) callback(new Error("media_address_blocked"));
          else callback(null, addresses, family);
        });
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300 &&
        String(response.headers["content-type"] || "").toLowerCase().startsWith(`${kind}/`));
    });
    const timer = setTimeout(() => req.destroy(new Error("media_timeout")), 5000);
    req.on("error", () => resolve(false));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

export async function refreshNewsletterMedia(issue, probe = probeAsset) {
  const safeProbe = async (url, kind) => {
    try { return await probe(url, kind); } catch { return false; }
  };
  const cards = await Promise.all(issue.cards.map(async (card) => {
    const image = card.image.status !== "available" || await safeProbe(card.image.url, "image")
      ? card.image : { status: "missing", reason: "unavailable" };
    const videos = [];
    for (const video of card.videos) {
      if (!await safeProbe(video.url, "video")) continue;
      const preview = video.preview && await safeProbe(video.preview.url, "image") ? video.preview : null;
      videos.push({ ...video, preview });
    }
    return { ...card, image, videos };
  }));
  return { ...issue, cards };
}
