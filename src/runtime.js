import pg from "pg";
import { refreshNewsletterMedia } from "./media.js";
import { createDigestReader } from "./source.js";
import { createUnisenderClient } from "./client.js";
import { createUnisenderCampaignRepository } from "./repository.js";
import { createCommonDigestPublisher } from "./service.js";
import { createSenderControl, createSenderControlRepository } from "./sender-control.js";

export function createUnisenderPublisherRuntime(config, { dryRun = false, onPoolError = () => {} } = {}) {
  const pools = [];
  function createPool(options, category) {
    const pool = new pg.Pool({
      ...options, max: 1, statement_timeout: 10_000, query_timeout: 12_000,
    });
    pool.on("error", () => onPoolError(category));
    pools.push(pool);
    return pool;
  }

  const active = dryRun ? config.dryRunReady : config.enabled;
  const reader = active ? createDigestReader({ topicId: config.topicId }, {
    pool: createPool(config.sourceDb, "unisender_source_pool_error"),
  }) : undefined;
  const journal = active && !dryRun
    ? createPool({ ...config.journalDb, options: "-c synchronous_commit=on" }, "unisender_journal_pool_error")
    : undefined;
  const repository = journal && createUnisenderCampaignRepository(journal, config);
  const client = active && !dryRun ? createUnisenderClient(config) : undefined;
  const publisher = createCommonDigestPublisher({ config, repository, digestReader: reader, client, refreshMedia: refreshNewsletterMedia });
  const control = journal && config.controlEnabled ? createSenderControl({
    config, publisher, client, control: createSenderControlRepository(journal, config), onError: onPoolError,
  }) : null;
  return {
    runControl: (signal) => control?.run(signal),
    tick: ({ signal } = {}) => publisher.tick({ dryRun, signal }),
    async close() {
      const results = await Promise.allSettled(pools.map((pool) => pool.end()));
      if (results.some(({ status }) => status === "rejected"))
        throw new Error("unisender_pool_close_failed");
    },
  };
}
