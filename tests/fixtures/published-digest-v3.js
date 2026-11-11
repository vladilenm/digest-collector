export const publishedDigestV3 = {
  schemaVersion: 3,
  digestId: "018f6e76-7b42-7d66-9c18-4ff1846b03aa",
  topic: {
    id: "ai-agents",
    title: "AI-агенты и автоматизация",
    language: "ru",
    timezone: "Europe/Moscow",
  },
  publicationDate: "2026-08-31",
  generatedAt: "2026-08-31T18:15:00.000Z",
  status: "complete",
  selectionMode: "standard",
  sourceStats: {
    telegram: { total: 2, succeeded: 2, skipped: 0 },
    web: { total: 3, succeeded: 2, skipped: 1 },
  },
  sections: {
    main: [
      {
        eventId: "event-openai-agents-sdk",
        title: "OpenAI обновила Agents SDK",
        claimKind: "fact",
        confidence: "confirmed",
        summary: "В SDK появился новый механизм оркестрации инструментов.",
        whyImportant:
          "Команды могут собирать надёжные агентные сценарии с меньшим количеством собственного кода.",
        affected: "Разработчики AI-продуктов и технические лиды.",
        keyQuote: {
          text: "Новый механизм управляет передачей управления между агентами.",
          url: "https://openai.com/index/agents-sdk-update/",
          sourceLabel: "OpenAI",
        },
        tags: [{ id: "agents", label: "AI-агенты" }],
        entities: [{ id: "openai", label: "OpenAI" }],
        sources: [
          {
            url: "https://openai.com/index/agents-sdk-update/",
            label: "OpenAI",
            role: "primary",
          },
          {
            url: "https://t.me/agent_news/42",
            label: "agent_news",
            role: "discovery",
          },
        ],
        publishedAt: "2026-08-31T12:00:00.000Z",
      },
    ],
    radar: [],
    focus: [],
  },
};
