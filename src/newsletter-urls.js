// Mirrored from topic-monitor email-period v1; keep in sync with producer.
import { isSafePublicUrl } from "./contract.js";
const telegramDomains = [
    "t.me",
    "telegram.me",
    "telegram.dog",
    "telegram.org",
    "telegram.com",
    "telesco.pe",
    "telegra.ph",
    "telegram-cdn.org",
    "tcdn.me",
    "cdn-telegram.org",
];
export function isTelegramUrl(raw) {
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase().replace(/\.$/, "");
        return (url.protocol === "tg:" ||
            telegramDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
    }
    catch {
        return false;
    }
}
export const isNewsletterUrl = (url) => isSafePublicUrl(url) && !isTelegramUrl(url);
export const containsLink = (text) => /(?:https?:\/\/|tg:\/\/|www\.|(?:t\.me|telegram\.(?:me|org|dog))\/)/i.test(text);
