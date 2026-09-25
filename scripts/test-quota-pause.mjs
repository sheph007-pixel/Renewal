// A provider's spending limit pauses the AI repairs instead of failing them:
// the error is recognised, the block names the date the provider gives, a
// probe is let through every half hour, and a call that works lifts it.
import assert from "node:assert/strict";
process.env.KENNION_QUOTA_PROBE_MS = "1800000";
const { recordUsage, aiQuotaBlock, lastQuotaBlock, quotaErrorCount, isQuotaError } = await import("../server/ai-usage.js");

const ANTHROPIC = `429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-10-01 at 00:00 UTC."}}`;
assert.ok(isQuotaError(ANTHROPIC));
assert.ok(isQuotaError("You exceeded your current quota, please check your plan and billing details. insufficient_quota"));
assert.ok(!isQuotaError("429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit"), "a per-minute rate limit is not a spending limit");
assert.ok(!isQuotaError("overloaded_error"));

assert.equal(aiQuotaBlock(), null);
const n0 = quotaErrorCount();
recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-sonnet-5", ok: false, error: ANTHROPIC });
assert.equal(quotaErrorCount(), n0 + 1);
const b = aiQuotaBlock();
assert.equal(b.provider, "anthropic");
assert.equal(b.until, "2026-10-01T00:00:00.000Z");
// Half an hour on, one call is let through to test it.
assert.equal(aiQuotaBlock(Date.now() + 31 * 60 * 1000), null, "a probe every half hour");
assert.ok(lastQuotaBlock(), "the page still shows the pause while a probe runs");
// Another provider working does not lift it; the same provider working does.
recordUsage({ purpose: "plan-audit-openai", provider: "openai", model: "gpt-5", ok: true });
assert.ok(aiQuotaBlock());
recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-sonnet-5", ok: true });
assert.equal(aiQuotaBlock(), null);
assert.equal(lastQuotaBlock(), null);
// A failure that is not a spending limit never pauses anything.
recordUsage({ purpose: "extraction", provider: "anthropic", model: "claude-sonnet-5", ok: false, error: "max_tokens" });
assert.equal(aiQuotaBlock(), null);
console.log("quota pause: a provider spending limit pauses the AI repairs (attempts not counted), is re-tested every half hour and lifts on the first call that works - ok");
