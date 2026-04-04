import { describe, it, assert } from "@effect/vitest";
import {
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} from "./providerAccountStatsNormalization";

describe("normalizeClaudeRateLimits", () => {
  it("normalizes a five_hour rate limit event", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
        utilization: 0.15,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 4,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Session");
    assert.equal(result[0]!.percentUsed, 15);
    assert.ok(result[0]!.resetsInMs! > 0);
    assert.ok(result[0]!.resetsAtIso);
  });

  it("normalizes a seven_day rate limit event", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed_warning" as const,
        rateLimitType: "seven_day" as const,
        utilization: 0.31,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 3,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Weekly");
    assert.equal(result[0]!.percentUsed, 31);
  });

  it("normalizes seven_day_sonnet to model-specific quota", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "seven_day_sonnet" as const,
        utilization: 0.03,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 24 * 5,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Sonnet");
    assert.equal(result[0]!.percentUsed, 3);
  });

  it("normalizes seven_day_opus to model-specific quota", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "seven_day_opus" as const,
        utilization: 0.5,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result[0]!.name, "Opus");
    assert.equal(result[0]!.percentUsed, 50);
  });

  it("returns empty array for unknown payload shape", () => {
    const result = normalizeClaudeRateLimits({ unexpected: true });
    assert.equal(result.length, 0);
  });

  it("handles missing utilization gracefully", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.percentUsed, 0);
  });
});

describe("normalizeCodexRateLimits", () => {
  it("returns empty array for unknown payload", () => {
    const result = normalizeCodexRateLimits({ unknown: true });
    assert.equal(result.length, 0);
  });
});
