import { deliveryMode, isProviderId } from "./config.js";

const apiBase = "https://api.unisender.com/ru/api/";
const maxResponseBytes = 64 * 1024;
const definitiveRejections = new Set([
  "invalid_api_key", "access_denied", "unknown_method", "invalid_arg",
  "not_enough_money", "api_call_limit_exceeded_for_api_key", "api_call_limit_exceeded_for_ip",
]);
export const isCampaignStatus = (value) => value === "scheduled" || value === "waits_censor";

export class UnisenderError extends Error {
  constructor(code, { ambiguous = true, campaignId, messageId } = {}) {
    super(code);
    this.ambiguous = ambiguous;
    this.campaignId = campaignId;
    this.messageId = messageId;
  }
}

async function readJson(response) {
  const stream = response.body?.getReader();
  if (!stream) throw new UnisenderError("unisender_invalid_response");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await stream.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        void stream.cancel().catch(() => {});
        throw new UnisenderError("unisender_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    stream.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UnisenderError("unisender_invalid_response");
  }
}

export function createUnisenderClient(config, { fetchImpl = fetch, timeoutMs = 45_000 } = {}) {
  function assertAllowed() {
    const mode = deliveryMode(config);
    if (config.provider !== "unisender" || config.enabled !== true || !mode)
      throw new UnisenderError("unisender_delivery_blocked", { ambiguous: false });
    return mode;
  }

  async function post(method, params) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}${method}?format=json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ api_key: config.apiKey, ...params }),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new UnisenderError("unisender_http_error");
      }
      const data = await readJson(response);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new UnisenderError("unisender_invalid_response");
      if (Object.hasOwn(data, "error") || Object.hasOwn(data, "code")) {
        const campaignId = method === "createCampaign" && isProviderId(data.result?.campaign_id)
          ? data.result.campaign_id : undefined;
        const messageId = method === "createEmailMessage" && isProviderId(data.result?.message_id)
          ? data.result.message_id : undefined;
        if (data.code === "campaign_already_exists")
          throw new UnisenderError("unisender_campaign_exists", { campaignId });
        if (!campaignId && !messageId && definitiveRejections.has(data.code))
          throw new UnisenderError("unisender_rejected", { ambiguous: false });
        throw new UnisenderError("unisender_provider_error", { campaignId, messageId });
      }
      return data.result;
    } catch (error) {
      if (error instanceof UnisenderError) throw error;
      throw new UnisenderError(signal.aborted ? "unisender_timeout" : "unisender_network_error");
    }
  }

  return {
    async createMessage({ subject, html, text }) {
      assertAllowed();
      const result = await post("createEmailMessage", {
        sender_email: config.fromEmail,
        sender_name: config.fromName,
        list_id: String(config.listId),
        subject,
        body: html,
        text_body: text,
        lang: "ru",
        wrap_type: "skip",
      });
      if (!isProviderId(result?.message_id))
        throw new UnisenderError("unisender_invalid_response");
      return result.message_id;
    },
    async startCampaign({ messageId }) {
      const mode = assertAllowed();
      if (!isProviderId(messageId))
        throw new UnisenderError("unisender_invalid_message_id", { ambiguous: false });
      const result = await post("createCampaign", {
        message_id: String(messageId),
        ...(mode === "test" ? { contacts: config.testRecipient } : {}),
        track_read: "0",
        track_links: "0",
        track_ga: "0",
      });
      const campaignId = isProviderId(result?.campaign_id) ? result.campaign_id : undefined;
      if (!campaignId || !isCampaignStatus(result.status))
        throw new UnisenderError("unisender_invalid_response", { campaignId });
      return { campaignId, providerStatus: result.status };
    },
  };
}
