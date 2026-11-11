import { postgresOptions } from "./postgres.js";
import { validIsoDate } from "./schedule.js";

const pilotRecipient = "digest@irreplaceable-ai.ru";
const email = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const idPattern = /^[1-9][0-9]*$/;

export const isProviderId = (value) => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

export function deliveryMode({ testRecipient, publicDeliveryEnabled }) {
  if (testRecipient === pilotRecipient) return "test";
  if (testRecipient === "" && publicDeliveryEnabled === true) return "public";
  return null;
}

function database(env, prefix) {
  try {
    return postgresOptions(env[`${prefix}_DATABASE_URL`], {
      ssl: env[`${prefix}_DATABASE_SSL`] || "require",
      network: env[`${prefix}_DATABASE_NETWORK`] || "remote",
    });
  } catch {
    return null;
  }
}

export function readUnisenderPublisherConfig(env = process.env) {
  const listId = idPattern.test(env.UNISENDER_LIST_ID) ? Number(env.UNISENDER_LIST_ID) : null;
  const config = {
    provider: env.NEWSLETTER_PROVIDER || "unisender",
    campaignsEnabled: env.UNISENDER_CAMPAIGNS_ENABLED === "true",
    publicDeliveryEnabled: env.UNISENDER_PUBLIC_DELIVERY_ENABLED === "true",
    accountReady: env.UNISENDER_ACCOUNT_READY === "true",
    apiKey: (env.UNISENDER_API_KEY || "").trim(),
    listId,
    fromEmail: (env.UNISENDER_FROM_EMAIL || pilotRecipient).trim(),
    fromName: (env.UNISENDER_FROM_NAME || "Владилен Минин · Незаменимые").trim(),
    firstSendDate: env.UNISENDER_FIRST_SEND_DATE || "",
    // Preserve a malformed nonempty value as blocked rather than broadening to the whole list.
    testRecipient: (env.NEWSLETTER_TEST_RECIPIENT || "").toLowerCase(),
    topicId: env.DIGEST_TOPIC_ID || "",
    journalDb: database(env, "NEWSLETTER"),
    sourceDb: database(env, "DIGEST"),
  };
  const mode = deliveryMode(config);
  const dryRunReady = config.provider === "unisender" &&
    !!config.sourceDb && /^[a-z][a-z0-9_-]{1,159}$/.test(config.topicId) &&
    validIsoDate(config.firstSendDate);
  const enabled = dryRunReady && !!config.journalDb && config.campaignsEnabled &&
    config.accountReady && !!config.apiKey && isProviderId(config.listId) &&
    email.test(config.fromEmail) && !!config.fromName && !/[\r\n]/.test(config.fromName) && !!mode;
  return Object.freeze({ ...config, mode, dryRunReady, enabled });
}
