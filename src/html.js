const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const anchor = (text, url) =>
  safeUrl(url)
    ? `<a href="${escape(safeUrl(url))}" style="color:#6A2BD8">${escape(text)}</a>`
    : escape(text);
const spanHtml = (span) => {
  let text = span.url ? anchor(span.text, span.url) : escape(span.text);
  return span.bold ? `<strong>${text}</strong>` : text;
};
const bodyHtml = (body) =>
  body
    .map((block) =>
      block.type === "list"
        ? `<ul>${block.items.map((spans) => `<li>${spans.map(spanHtml).join("")}</li>`).join("")}</ul>`
        : `<p>${block.spans.map(spanHtml).join("")}</p>`,
    )
    .join("");
const bodyText = (body) =>
  body
    .map((block) =>
      block.type === "list"
        ? block.items
            .map(
              (spans) =>
                `• ${spans.map((s) => s.text + (safeUrl(s.url) ? ` (${safeUrl(s.url)})` : "")).join("")}`,
            )
            .join("\n")
        : block.spans
            .map((s) => s.text + (safeUrl(s.url) ? ` (${safeUrl(s.url)})` : ""))
            .join(""),
    )
    .join("\n\n");

export { anchor, bodyHtml, bodyText, escape, safeUrl };
