import { NewsletterIssueSchema } from "./newsletter-contract.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { anchor, escape, safeUrl } from "./html.js";

const shell = readFileSync(new URL("./email-shell.html", import.meta.url), "utf8");
const bodyFont = "'Golos Text','Segoe UI',Arial,sans-serif";
const titleFont = "Spectral,Georgia,'Times New Roman',serif";
// Unisender sees the raw HTML and plain-text variants before a mail client does.
const literal = (text) => text.replaceAll("{", "｛").replaceAll("}", "｝");
const safeSourceUrl = (url) =>
  safeUrl(url)?.replaceAll("{", "%7B").replaceAll("}", "%7D");
const displayDate = (date) => date.split("-").reverse().join(".");

export function renderCommonDigest({ issues, fromDate, toDate }) {
  const range = `${displayDate(fromDate)} — ${displayDate(toDate)}`;
  const subject = `Главное об ИИ · ${range}`;
  const html = [];
  const text = [subject, "Привет! Собрал главное об ИИ за три дня."];
  if (issues.length !== 1) throw new Error("expected_one_prepared_newsletter");
  const issue = NewsletterIssueSchema.parse(issues[0]);
  if (issue.period.fromDate !== fromDate || issue.period.toDate !== toDate)
    throw new Error("newsletter_period_mismatch");
  for (const card of issue.cards) {
    const title = literal(card.title);
    const paragraphs = card.sentences.map(literal);
    const sources = card.sources.map(({ label, url }) => ({ label: literal(label), url: safeSourceUrl(url) }));
    const image = card.image.status === "available" ? card.image : card.videos.find((v) => v.preview)?.preview;
    const picture = image
      ? `<a href="${escape(safeSourceUrl(image.sourceUrl))}"><img src="${escape(safeSourceUrl(image.url))}" alt="${escape(title)}" width="544" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:12px;margin:0 0 18px;"></a>`
      : "";
    const videoLinks = card.videos.map((v, i) => anchor(`Видео${card.videos.length > 1 ? ` ${i + 1}` : ""}`, safeSourceUrl(v.sourceUrl))).join(" · ");
    const sourceHtml = sources.length ? `<p style="font-size:13px;line-height:21px;">${sources.map(({label,url}) => anchor(label,url)).join(" · ")}</p>` : "";
    html.push(`<tr><td class="content-pad ink" style="padding:0 48px 28px;font-family:${bodyFont};font-size:16px;line-height:26px;color:#16121E;">
      <h2 style="margin:0 0 14px;font-family:${titleFont};font-size:27px;line-height:33px;font-weight:400;">${escape(title)}</h2>
      ${picture}<p>${paragraphs.map(escape).join(" ")}</p>${sourceHtml}${videoLinks ? `<p>${videoLinks}</p>` : ""}
    </td></tr>`);
    text.push([title, paragraphs.join(" "), sources.map(({label,url}) => `${label}: ${url}`).join("\n")].filter(Boolean).join("\n\n"));
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
    issueIds: [issue.issueId],
    itemCount: issue.cards.length,
    contentHash: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
  };
}
