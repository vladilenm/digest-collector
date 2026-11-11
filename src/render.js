import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { anchor, bodyHtml, bodyText, escape, safeUrl } from "./html.js";

const shell = readFileSync(new URL("./email-shell.html", import.meta.url), "utf8");
const bodyFont = "'Golos Text','Segoe UI',Arial,sans-serif";
const titleFont = "Spectral,Georgia,'Times New Roman',serif";
// Unisender sees the raw HTML and plain-text variants before a mail client does.
const literal = (text) => text.replaceAll("{", "｛").replaceAll("}", "｝");
const safeSourceUrl = (url) =>
  safeUrl(url)?.replaceAll("{", "%7B").replaceAll("}", "%7D");
const cleanSpans = (spans) => spans.map((span) => ({
  ...span, text: literal(span.text), url: safeSourceUrl(span.url),
}));
const cleanBody = (body) => body.map((block) => block.type === "list"
  ? { ...block, items: block.items.map(cleanSpans) }
  : { ...block, spans: cleanSpans(block.spans) });
const displayDate = (date) => date.split("-").reverse().join(".");

export function renderCommonDigest({ issues, fromDate, toDate }) {
  const range = `${displayDate(fromDate)} — ${displayDate(toDate)}`;
  const subject = `Главное об ИИ · ${range}`;
  const html = [];
  const text = [subject, "Привет! Собрал главное об ИИ за три дня."];
  const seen = new Set();

  // The reader orders newest first; keep the most recent version of each event.
  for (const issue of issues) {
    const items = issue.items.filter(({ eventId }) => {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    });
    if (!items.length) continue;
    const date = displayDate(issue.publicationDate);
    text.push(date);
    html.push(`<tr><td class="content-pad section-pad" style="padding:0 48px 12px;"><p class="subtle" style="margin:0;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:12px;line-height:18px;color:#6B6578;">${date}</p></td></tr>`);
    for (const item of items) {
      const title = literal(item.title);
      const body = cleanBody(item.body);
      const sources = item.sources.flatMap(({ label, url }) => {
        const sanitized = safeSourceUrl(url);
        return sanitized ? [{ label: literal(label), url: sanitized }] : [];
      });
      const sourceHtml = sources.length
        ? `<p style="font-size:13px;line-height:21px;">${sources.map(({ label, url }) => anchor(label, url)).join(" · ")}</p>`
        : "";
      html.push(`<tr><td class="content-pad ink" style="padding:0 48px 28px;font-family:${bodyFont};font-size:16px;line-height:26px;color:#16121E;">
        <h2 style="margin:0 0 10px;font-family:${titleFont};font-size:27px;line-height:33px;font-weight:400;">${escape(title)}</h2>
        ${bodyHtml(body)}${sourceHtml}
      </td></tr>`);
      text.push([title, bodyText(body), sources.map(({ label, url }) => `${label}: ${url}`).join("\n")]
        .filter(Boolean).join("\n\n"));
    }
  }
  text.push("Владилен\nКлуб «Незаменимые»", "Отписаться: {{UnsubscribeUrl}}");
  const slots = { subject, range, content: html.join("\n") };
  const message = {
    subject,
    html: shell.replace(/%%(subject|range|content)%%/g, (_, slot) => slots[slot]),
    text: text.join("\n\n"),
  };
  return {
    ...message,
    issueIds: issues.map(({ digestId }) => digestId),
    itemCount: seen.size,
    contentHash: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
  };
}
