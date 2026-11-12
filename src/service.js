import { isCampaignStatus, UnisenderError } from "./client.js";
import { isProviderId } from "./config.js";
import { renderCommonDigest } from "./render.js";
import { normalizeNewsletter } from "./source.js";
import { commonWindow } from "./schedule.js";


export function createCommonDigestPublisher({
  config, repository, digestReader, client, render = renderCommonDigest,
  now = () => new Date(), refreshMedia = async (issue) => issue,
}) {
  async function prepare({ fromDate, toDate }) {
    const issues = await digestReader.range({ fromDate, toDate });
    if (!Array.isArray(issues) || issues.length > 1) throw new Error("invalid_newsletter_source");
    if (!issues.length) return null;
    normalizeNewsletter(issues[0], { topicId: config.topicId, fromDate, toDate });
    return render({ issues: [await refreshMedia(issues[0])], fromDate, toDate });
  }

  async function tick({ dryRun = false, signal } = {}) {
    let issueCount = 0;
    let itemCount = 0;
    const summary = (status) => ({ status, dryRun, issueCount, itemCount });
    if (dryRun && !config.dryRunReady) return summary("invalid_config");
    if (!dryRun && !config.enabled) return summary("disabled");
    const window = commonWindow(now(), config.firstSendDate);
    if (!window) return summary("not_due");
    if (signal?.aborted) return summary("stopped");
    if (dryRun) {
      try {
        const prepared = await prepare(window);
        if (!prepared) return summary("awaiting_issue");
        issueCount = prepared.issueIds.length;
        itemCount = prepared.itemCount;
        return summary(itemCount ? "preview" : "skipped");
      } catch {
        return summary("failed");
      }
    }

    // Source availability is checked before claiming: an unfinished LLM run must
    // not consume the send slot, and it must never fall back to daily issues.
    let prepared;
    try {
      prepared = await prepare(window);
      if (!prepared) return summary("awaiting_issue");
    } catch {
      return summary("failed");
    }
    const key = { ...window, topicId: config.topicId, listId: config.listId, mode: config.mode };
    try {
      if (!(await repository.claim(key))) return summary("already_claimed");
    } catch {
      return summary("failed");
    }

    let state = "preparing";
    const advance = async (next, fields) => {
      await repository.transition(key, state, next, fields);
      state = next;
    };
    // A network request is only started while today's window is still open.
    const canContinue = () => !signal?.aborted &&
      commonWindow(now(), config.firstSendDate)?.sendDate === window.sendDate;
    let phase = "source_failed";
    let messageId;
    let campaign;
    try {
      const { issueIds, contentHash } = prepared;
      issueCount = issueIds.length;
      itemCount = prepared.itemCount;
      phase = "journal_write_failed";
      if (!itemCount) {
        await advance("skipped", { issueIds });
        return summary("skipped");
      }
      await advance("preparing", { issueIds, contentHash });
      phase = "window_closed";
      if (!canContinue()) throw new Error(phase);
      phase = "draft_request_failed";
      messageId = await client.createMessage(prepared);
      if (!isProviderId(messageId)) {
        messageId = undefined;
        throw new UnisenderError("unisender_invalid_response");
      }
      phase = "journal_write_failed";
      await advance("draft", { messageId });
      await advance("sending");
      phase = "window_closed";
      if (!canContinue()) throw new Error(phase);
      phase = "campaign_request_failed";
      const result = await client.startCampaign({ messageId });
      if (!isProviderId(result?.campaignId) || !isCampaignStatus(result?.providerStatus))
        throw new UnisenderError("unisender_invalid_response", {
          campaignId: isProviderId(result?.campaignId) ? result.campaignId : undefined,
        });
      campaign = result;
      phase = "journal_write_failed";
      await advance("accepted", campaign);
      return summary("accepted");
    } catch (error) {
      const providerError = error instanceof UnisenderError ? error : null;
      const ambiguous = Boolean(campaign ||
        ((phase === "draft_request_failed" || phase === "campaign_request_failed") &&
          providerError?.ambiguous !== false));
      const terminal = ambiguous ? "uncertain" : "failed";
      messageId ??= providerError?.messageId;
      try {
        await advance(terminal, {
          ...(messageId && state === "preparing" ? { messageId } : {}),
          ...(providerError?.campaignId ? { campaignId: providerError.campaignId } : {}),
          ...campaign,
          failureCode: providerError?.message || phase,
        });
      } catch {
        // A stale or unreachable journal remains non-retryable; never issue another request.
      }
      return summary(terminal);
    }
  }

  return { tick };
}
