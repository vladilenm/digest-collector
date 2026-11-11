import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { postgresOptions } from "../src/postgres.js";

const url = process.env.NEWSLETTER_MIGRATION_URL;
if (!url) {
  console.error("NEWSLETTER_MIGRATION_URL is required (owner credential).");
  process.exitCode = 1;
} else {
  let pool;
  let client;
  try {
    pool = new pg.Pool(
      postgresOptions(url, {
        ssl: process.env.NEWSLETTER_DATABASE_SSL,
        network: process.env.NEWSLETTER_DATABASE_NETWORK,
      }),
    );
    pool.on("error", () =>
      console.warn("newsletter_migration_connection_lost"),
    );
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('club-newsletter-migrations'))",
    );
    await client.query("CREATE SCHEMA IF NOT EXISTS newsletter");
    await client.query(
      "CREATE TABLE IF NOT EXISTS newsletter.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await client.query(
      "REVOKE ALL ON newsletter.schema_migrations FROM PUBLIC",
    );
    const directory = new URL("../database/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => /^\d+[-_].*\.sql$/.test(name))
      .sort();
    let applied = 0;
    for (const name of files) {
      const exists = await client.query(
        "SELECT 1 FROM newsletter.schema_migrations WHERE name=$1",
        [name],
      );
      if (exists.rowCount) continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query(
        "INSERT INTO newsletter.schema_migrations(name) VALUES($1)",
        [name],
      );
      applied++;
    }
    await client.query("COMMIT");
    console.info(JSON.stringify({ applied }));
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("newsletter_migration_failed");
    process.exitCode = 1;
  } finally {
    client?.release();
    try {
      await pool?.end();
    } catch {
      console.error("newsletter_migration_shutdown_failed");
      process.exitCode = 1;
    }
  }
}
