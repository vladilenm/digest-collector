// Mirrored from topic-monitor email-period v1; keep in sync with producer.
import { z } from "zod";
import { CalendarDate, datesInPeriod, newsletterPeriod } from "./newsletter-period.js";
const MaterialId = z.string().regex(/^mat-[a-f0-9]{64}$/);
import { containsLink, isNewsletterUrl, isTelegramUrl } from "./newsletter-urls.js";
export const NewsletterUrl = z
    .string()
    .url()
    .max(2048)
    .refine(isNewsletterUrl, "newsletter URLs must be public websites, never Telegram");
const Copy = (max) => z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !containsLink(text) && !/[<>]/.test(text), "plain text required; use sources for links");
export const isSingleSentence = (text) => [
    ...new Intl.Segmenter("ru", { granularity: "sentence" }).segment(text),
].filter((part) => part.segment.trim()).length === 1;
export const ClaimKind = z.enum([
    "release",
    "experiment",
    "company_statement",
    "rumor",
    "analysis",
    "mixed",
]);
const Asset = z
    .object({
    url: NewsletterUrl,
    sourceUrl: NewsletterUrl,
    checkedAt: z.string().datetime(),
})
    .strict();
export const ImageSchema = z.discriminatedUnion("status", [
    Asset.extend({ status: z.literal("available") }).strict(),
    z
        .object({
        status: z.literal("missing"),
        reason: z.enum(["not_found", "unavailable", "telegram_only"]),
    })
        .strict(),
]);
export const NewsletterCardSchema = z
    .object({
    cardId: z.string().regex(/^card-[a-f0-9]{24}$/),
    title: Copy(140),
    claimKind: ClaimKind,
    sentences: z
        .array(Copy(700).refine(isSingleSentence, "one sentence per element required"))
        .min(2)
        .max(4),
    materialIds: z.array(MaterialId).min(1),
    sources: z.array(z
        .object({ url: NewsletterUrl, label: z.string().min(1).max(200) })
        .strict()),
    image: ImageSchema,
    videos: z
        .array(Asset.extend({ preview: Asset.nullable() }).strict())
        .max(8),
})
    .strict()
    .superRefine((card, ctx) => {
    const urls = new Set(card.sources.map((s) => s.url));
    const assets = [
        ...(card.image.status === "available" ? [card.image] : []),
        ...card.videos,
        ...card.videos.flatMap((v) => (v.preview ? [v.preview] : [])),
    ];
    if (assets.some((asset) => !urls.has(asset.sourceUrl)))
        ctx.addIssue({
            code: "custom",
            message: "media provenance must be a card source",
        });
    if (new Set(card.materialIds).size !== card.materialIds.length ||
        urls.size !== card.sources.length)
        ctx.addIssue({ code: "custom", message: "duplicate references" });
});
export const NewsletterIssueSchema = z
    .object({
    schemaVersion: z.literal(1),
    issueType: z.literal("email-period"),
    issueId: z.string().uuid(),
    topic: z
        .object({
        id: z.string().min(1),
        title: Copy(160),
        language: z.string().regex(/^[a-z]{2}$/),
    })
        .strict(),
    period: z
        .object({
        fromDate: CalendarDate,
        toDate: CalendarDate,
        timezone: z.literal("Europe/Moscow"),
        startAt: z.string().datetime(),
        endBefore: z.string().datetime(),
    })
        .strict(),
    preparedAt: z.string().datetime(),
    model: z.string().min(1),
    status: z.enum(["ready", "empty"]),
    inputCoverage: z
        .object({
        basis: z.enum(["source-archive", "published-history", "mixed"]),
        materialCount: z.number().int().nonnegative(),
        datesWithMaterials: z.array(CalendarDate),
        missingDates: z.array(CalendarDate),
    })
        .strict(),
    cards: z.array(NewsletterCardSchema).max(8),
})
    .strict()
    .superRefine((issue, ctx) => {
    try {
        const expected = newsletterPeriod(issue.period.fromDate, issue.period.toDate, new Date(issue.preparedAt));
        if (JSON.stringify(expected) !== JSON.stringify(issue.period))
            ctx.addIssue({
                code: "custom",
                message: "inconsistent period boundaries",
            });
        const dates = datesInPeriod(issue.period), coverage = issue.inputCoverage;
        if (new Set([...coverage.datesWithMaterials, ...coverage.missingDates])
            .size !== dates.length ||
            dates.some((day) => coverage.datesWithMaterials.includes(day) ===
                coverage.missingDates.includes(day)) ||
            [...coverage.datesWithMaterials, ...coverage.missingDates].some((day) => !dates.includes(day)))
            ctx.addIssue({ code: "custom", message: "inconsistent coverage" });
    }
    catch {
        ctx.addIssue({ code: "custom", message: "invalid period" });
    }
    if ((issue.cards.length === 0) !== (issue.status === "empty"))
        ctx.addIssue({ code: "custom", message: "status must match cards" });
    if (new Set(issue.cards.map((c) => c.cardId)).size !== issue.cards.length)
        ctx.addIssue({ code: "custom", message: "duplicate cards" });
    // Defence in depth: no Telegram links anywhere in the public document.
    const strings = (value) => typeof value === "string"
        ? [value]
        : Array.isArray(value)
            ? value.flatMap(strings)
            : value && typeof value === "object"
                ? Object.values(value).flatMap(strings)
                : [];
    if (strings(issue).some(isTelegramUrl))
        ctx.addIssue({ code: "custom", message: "Telegram URL in newsletter" });
});
