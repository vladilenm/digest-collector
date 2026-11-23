import { isCampaignStatus, UnisenderError } from "./client.js";
import { isProviderId } from "./config.js";
import { renderCommonDigest } from "./render.js";
import { normalizeNewsletter } from "./source.js";
import { selectedSendWindow } from "./schedule.js";


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

  async function tick({ dryRun = false, signal, sendDate, retryAttempt = 0, requestActive } = {}) {
    let issueCount = 0;
    let itemCount = 0;
    const summary = (status) => ({ status, dryRun, issueCount, itemCount });
    if (dryRun && !config.dryRunReady) return summary("invalid_config");
    if (!dryRun && !config.enabled) return summary("disabled");
    const window = selectedSendWindow(now(), config.firstSendDate, sendDate);
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
    const key = { ...window, topicId: config.topicId, listId: config.listId, mode: config.mode };
    let prepared;
    try {
      if (!retryAttempt && await repository.isClaimed?.(key)) return summary("already_claimed");
      prepared = await prepare(window);
      if (!prepared) return summary("awaiting_issue");
    } catch {
      return summary("failed");
    }
    try {
      let verifiedCampaignId = null;
      if (retryAttempt) {
        const candidate = await repository.retryCandidate(key, retryAttempt);
        if (!candidate) return summary("already_claimed");
        if (candidate.campaign_id != null) {
          // Moderation can follow a trial batch. Even a final decline cannot
          // authorize a full-list retry unless Unisender confirms zero sends.
          let stats;
          try {
            const status = await client.campaignStatus(candidate.campaign_id);
            if (status !== "declined") return summary("retry_unverified");
            stats = await client.campaignStats(candidate.campaign_id);
          } catch {
            return summary("provider_unavailable");
          }
          if (stats.sent > 0 || stats.delivered > 0)
            await repository.rememberDispatch(key, retryAttempt, candidate.campaign_id);
          if (stats.sent !== 0 || stats.delivered !== 0) return summary("retry_unverified");
          verifiedCampaignId = candidate.campaign_id;
        }
      }
      if (requestActive && !(await requestActive())) return summary("worker_stale");
      const claimed = retryAttempt
        ? await repository.claimRejected(key, retryAttempt, verifiedCampaignId)
        : await repository.claim(key);
      if (!claimed) return summary("already_claimed");
    } catch {
      return summary("failed");
    }

    let state = "preparing";
    const advance = async (next, fields) => {
      await repository.transition(key, state, next, fields);
      state = next;
    };
    async function assertCanDispatch() {
      if (signal?.aborted || selectedSendWindow(now(), config.firstSendDate, sendDate)?.sendDate !== window.sendDate)
        throw new Error("window_closed");
      if (requestActive) {
        phase = "command_inactive_before_dispatch";
        if (!(await requestActive())) throw new Error(phase);
      }
    }
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
      await assertCanDispatch();
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
      await assertCanDispatch();
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
          ...(providerError?.rejectionCode ? { rejectionCode: providerError.rejectionCode } : {}),
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
