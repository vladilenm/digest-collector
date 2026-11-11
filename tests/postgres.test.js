import assert from "node:assert/strict";
import { test } from "node:test";
import { postgresOptions } from "../src/postgres.js";

test("explicit private database mode permits RFC1918 addresses only", () => {
  for (const host of ["10.0.0.4", "172.16.0.4", "172.31.255.4", "192.168.0.4"])
    assert.equal(postgresOptions(`postgresql://user:password@${host}/db`, { ssl: "off", network: "private" }).ssl, false);
  for (const host of ["8.8.8.8", "172.15.0.4", "172.32.0.4", "192.169.0.4", "db.example.org", "127.0.0.1"])
    assert.throws(() => postgresOptions(`postgresql://user:password@${host}/db`, { ssl: "off", network: "private" }));
  assert.equal(postgresOptions("postgresql://user:password@10.0.0.4/db", { network: "private" }).ssl.rejectUnauthorized, true);
});

test("pg cannot override verified TLS or a checked network address through URL parameters", async () => {
  const { default: pg } = await import("pg");
  for (const query of ["ssl=0", "ssl=no-verify", "sslmode=disable", "sslrootcert=bad", "host=8.8.8.8&ssl=0"])
    assert.equal(new pg.Client(postgresOptions(`postgresql://user:password@db.example.org/db?${query}`)).connectionParameters.ssl.rejectUnauthorized, true);
  const client = new pg.Client(postgresOptions("postgresql://user:password@10.0.0.4/db?host=8.8.8.8&port=80", { ssl: "off", network: "private" }));
  assert.equal(client.connectionParameters.host, "10.0.0.4");
  assert.equal(client.connectionParameters.port, 5432);
});

test("malformed database URLs never survive in thrown diagnostic properties", async () => {
  const { inspect } = await import("node:util");
  const secret = "synthetic-diagnostic-secret";
  let caught;
  try {
    postgresOptions(`postgresql://test-user:${secret}@[broken/database`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.message, "invalid_database_url");
  assert.equal(caught.input, undefined);
  assert.equal(caught.cause, undefined);
  assert.ok(!inspect(caught, { showHidden: true }).includes(secret));
});
