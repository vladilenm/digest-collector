// Public consumer contract mirrored from Topic Digest PublishedDigest v3/v4.
// Keep version changes coordinated with producer; never import producer runtime.
import { z } from "zod";
import { isIP } from "node:net";

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{1,159}$/);
const Label = z.string().trim().min(1).max(160);
const UtcTimestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const PublicationDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "publication date must be a real calendar date");
const PublicUrl = z
  .string()
  .url()
  .refine(isSafePublicUrl, "url must be public HTTP(S)");
const Timezone = Label.refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, "timezone must be supported by Intl.DateTimeFormat");

const SourceStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((stats, context) => {
    if (stats.succeeded + stats.skipped !== stats.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source stats must account for every configured source",
      });
    }
  });

const LabeledIdSchema = z
  .object({
    id: Identifier,
    label: Label,
  })
  .strict();

const PublishedSourceSchema = z
  .object({
    url: PublicUrl,
    label: Label,
    role: z.enum(["primary", "discovery", "linked", "analysis"]),
  })
  .strict();

export const PublishedEventSchema = z
  .object({
    eventId: Label,
    title: z.string().trim().min(1).max(240),
    claimKind: z.enum(["fact", "research", "analysis", "rumor"]),
    confidence: z.enum(["confirmed", "corroborated", "single-source", "rumor"]),
    summary: z.string().trim().min(1).max(2_000),
    whyImportant: z.string().trim().min(1).max(2_000),
    affected: z.string().trim().min(1).max(1_000),
    keyQuote: z
      .object({
        text: z.string().trim().min(1).max(2_000),
        url: PublicUrl,
        sourceLabel: Label,
      })
      .strict(),
    tags: z.array(LabeledIdSchema).max(20),
    entities: z.array(LabeledIdSchema).max(100),
    sources: z.array(PublishedSourceSchema).min(1).max(20),
    publishedAt: UtcTimestamp,
  })
  .strict()
  .superRefine((event, context) => {
    const quoteSource = event.sources.find(
      ({ url }) => url === event.keyQuote.url,
    );
    if (!quoteSource || quoteSource.label !== event.keyQuote.sourceLabel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keyQuote"],
        message: "key quote must reference a labeled event source",
      });
    }
  });

export const PublishedDigestV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    digestId: z.string().uuid(),
    topic: z
      .object({
        id: Identifier,
        title: Label,
        language: z.string().regex(/^[a-z]{2}$/),
        timezone: Timezone,
      })
      .strict(),
    publicationDate: PublicationDate,
    generatedAt: UtcTimestamp,
    status: z.enum(["complete", "partial"]),
    selectionMode: z.enum(["standard", "focus"]),
    sourceStats: z
      .object({
        telegram: SourceStatsSchema,
        web: SourceStatsSchema,
      })
      .strict(),
    sections: z
      .object({
        main: z.array(PublishedEventSchema).max(20),
        radar: z.array(PublishedEventSchema).max(20),
        focus: z.array(PublishedEventSchema).max(3),
      })
      .strict(),
  })
  .strict()
  .superRefine((digest, context) => {
    const hasStandardEvents =
      digest.sections.main.length + digest.sections.radar.length > 0;
    const hasFocusEvents = digest.sections.focus.length > 0;
    if (
      digest.selectionMode === "standard" &&
      (!hasStandardEvents || hasFocusEvents)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "standard digest requires main or radar and forbids focus",
        path: ["sections"],
      });
    }
    if (
      digest.selectionMode === "focus" &&
      (hasStandardEvents || !hasFocusEvents)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focus digest requires focus and forbids main or radar",
        path: ["sections"],
      });
    }
  });

const EditorialUrl = z
  .string()
  .url()
  .max(2048)
  .refine(isSafePublicUrl, "url must be public HTTP(S)");
const EditorialSpanSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(1100)
      .refine((text) => Boolean(text.trim()), "text must be nonempty"),
    bold: z.boolean().optional(),
    url: EditorialUrl.optional(),
  })
  .strict();
const EditorialSpans = z.array(EditorialSpanSchema).min(1).max(12);
const EditorialBodySchema = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("paragraph"), spans: EditorialSpans })
        .strict(),
      z
        .object({
          type: z.literal("list"),
          items: z.array(EditorialSpans).min(1).max(3),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(4)
  .superRefine((body, context) => {
    const spans = body.flatMap((block) =>
      block.type === "paragraph" ? block.spans : block.items.flat(),
    );
    if (!body.some((block) => block.type === "paragraph")) {
      context.addIssue({
        code: "custom",
        message: "body requires a paragraph",
      });
    }
    if (spans.reduce((length, span) => length + span.text.length, 0) > 1100) {
      context.addIssue({
        code: "custom",
        message: "body exceeds 1100 characters",
      });
    }
    const links = spans.filter((span) => span.url);
    if (links.length < 1 || links.length > 3) {
      context.addIssue({
        code: "custom",
        message: "body requires one to three source links",
      });
    }
  });

export const PublishedEditorialEventSchema = z
  .object({
    eventId: Label,
    title: z.string().trim().min(1).max(140),
    claimKind: z.enum(["fact", "research", "analysis", "rumor"]),
    body: EditorialBodySchema,
    tags: z.array(LabeledIdSchema).max(20),
    entities: z.array(LabeledIdSchema).max(100),
    sources: z
      .array(PublishedSourceSchema.extend({ url: EditorialUrl }))
      .min(1)
      .max(100),
    keyQuote: z
      .object({
        text: z.string().trim().min(1).max(2000),
        url: EditorialUrl,
        sourceLabel: Label,
      })
      .strict(),
    publishedAt: UtcTimestamp,
    media: z
      .object({
        type: z.enum(["photo", "video"]),
        url: EditorialUrl,
        sourceUrl: EditorialUrl,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const urls = new Set(event.sources.map((source) => source.url));
    const spans = event.body.flatMap((block) =>
      block.type === "paragraph" ? block.spans : block.items.flat(),
    );
    if (spans.some((span) => span.url && !urls.has(span.url))) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "body links must identify event sources",
      });
    }
    if (event.media && !urls.has(event.media.sourceUrl)) {
      context.addIssue({
        code: "custom",
        path: ["media"],
        message: "media must identify an event source",
      });
    }
    const quoteSource = event.sources.find(
      (source) => source.url === event.keyQuote.url,
    );
    if (!quoteSource || quoteSource.label !== event.keyQuote.sourceLabel) {
      context.addIssue({
        code: "custom",
        path: ["keyQuote"],
        message: "quote must identify a labeled event source",
      });
    }
  });

export const PublishedDigestV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    digestId: z.string().uuid(),
    topic: z
      .object({
        id: Identifier,
        title: Label,
        language: z.string().regex(/^[a-z]{2}$/),
        timezone: Timezone,
      })
      .strict(),
    publicationDate: PublicationDate,
    generatedAt: UtcTimestamp,
    status: z.enum(["complete", "partial"]),
    sourceStats: z
      .object({ telegram: SourceStatsSchema, web: SourceStatsSchema })
      .strict(),
    items: z.array(PublishedEditorialEventSchema).min(1).max(8),
  })
  .strict()
  .superRefine((digest, context) => {
    if (
      new Set(digest.items.map((event) => event.eventId)).size !==
      digest.items.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "event identifiers must be unique",
      });
    }
  });

export const PublishedDigestSchema = z.union([
  PublishedDigestV3Schema,
  PublishedDigestV4Schema,
]);

export function isSafePublicUrl(raw) {
  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return false;
    if (url.username || url.password) return false;

    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const forbidden = [
      /^localhost$/i,
      /^0\./,
      /^10\./,
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
      /^127\./,
      /^169\.254\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.0\.0\./,
      /^192\.0\.2\./,
      /^192\.168\./,
      /^198\.(1[89])\./,
      /^198\.51\.100\./,
      /^203\.0\.113\./,
      /^(22[4-9]|23\d|24\d|25[0-5])\./,
      /^::/,
      /^64:ff9b:/i,
      /^2001:(?:0:|db8:)/i,
      /^2002:/i,
      /^f[cd][0-9a-f]{2}:/i,
      /^fe[89a-f][0-9a-f]:/i,
      /^ff[0-9a-f]{2}:/i,
    ];

    return (
      !forbidden.some((pattern) => pattern.test(hostname)) &&
      (isIP(hostname) !== 0 ||
        (!hostname.endsWith(".local") && !hostname.endsWith(".localhost")))
    );
  } catch {
    return false;
  }
}
