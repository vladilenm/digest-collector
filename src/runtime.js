import pg from "pg";
import { createDigestReader } from "./source.js";
import { createUnisenderClient } from "./client.js";
import { createUnisenderCampaignRepository } from "./repository.js";
import { createCommonDigestPublisher } from "./service.js";

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
  const repository = active && !dryRun
    ? createUnisenderCampaignRepository(createPool({ ...config.journalDb, options: "-c synchronous_commit=on" }, "unisender_journal_pool_error"))
    : undefined;
  const client = active && !dryRun ? createUnisenderClient(config) : undefined;
  const publisher = createCommonDigestPublisher({ config, repository, digestReader: reader, client });
  return {
    tick: ({ signal } = {}) => publisher.tick({ dryRun, signal }),
    async close() {
      const results = await Promise.allSettled(pools.map((pool) => pool.end()));
      if (results.some(({ status }) => status === "rejected"))
        throw new Error("unisender_pool_close_failed");
    },
  };
}
