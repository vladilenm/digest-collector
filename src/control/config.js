import { postgresOptions } from "../postgres.js";
import { isProviderId } from "../config.js";
import { validIsoDate } from "../schedule.js";

export function readControlConfig(env) {
  const origin = new URL(env.CONTROL_ORIGIN);
  const local =
    origin.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  if (
    (!local && origin.protocol !== "https:") ||
    origin.origin !== env.CONTROL_ORIGIN
  )
    throw new Error("invalid_control_origin");
  const password = /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/.exec(
    env.CONTROL_PASSWORD_HASH || "",
  );
  const listId = Number(env.UNISENDER_LIST_ID);
  const mode = env.CONTROL_MODE;
  const port = Number(env.PORT || 8080);
  if (
    !password ||
    !env.CONTROL_USER?.trim() ||
    !["test", "public"].includes(mode) ||
    !validIsoDate(env.UNISENDER_FIRST_SEND_DATE) ||
    !isProviderId(listId) ||
    !/^[a-z][a-z0-9_-]{1,159}$/.test(env.DIGEST_TOPIC_ID || "") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("invalid_control_config");
  function connection(prefix) {
    return postgresOptions(env[`${prefix}_DATABASE_URL`], {
      ssl: env[`${prefix}_DATABASE_SSL`] || "require",
      network: env[`${prefix}_DATABASE_NETWORK`] || "remote",
    });
  }
  return {
    origin: origin.origin,
    secure: !local,
    host: local ? origin.hostname.replace(/^\[|\]$/g, "") : "0.0.0.0",
    port,
    username: env.CONTROL_USER.trim(),
    salt: password[1],
    hash: Buffer.from(password[2], "hex"),
    first: env.UNISENDER_FIRST_SEND_DATE,
    topic: env.DIGEST_TOPIC_ID,
    mode,
    listId,
    sourceDb: connection("DIGEST"),
    journalDb: connection("NEWSLETTER"),
  };
}
