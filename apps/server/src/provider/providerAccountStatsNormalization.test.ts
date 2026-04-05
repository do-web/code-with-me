import { describe, it, assert } from "@effect/vitest";
import {
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} from "./providerAccountStatsNormalization";

describe("normalizeClaudeRateLimits", () => {
  it("uses utilization when provided", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
        utilization: 0.59,
        resetsAt: Math.floor(Date.now() / 1000) + 3600 * 2,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Session");
    assert.equal(result[0]!.percentUsed, 59);
    assert.ok(result[0]!.resetsInMs! > 0);
  });

  it("maps rateLimitType to human-readable names", () => {
    const types = [
      ["five_hour", "Session"],
      ["seven_day", "Weekly"],
      ["seven_day_opus", "Opus"],
      ["seven_day_sonnet", "Sonnet"],
      ["overage", "Overage"],
    ] as const;

    for (const [rateLimitType, expectedName] of types) {
      const raw = {
        type: "rate_limit_event" as const,
        rate_limit_info: {
          status: "allowed" as const,
          rateLimitType,
          utilization: 0.5,
        },
        uuid: "test",
        session_id: "test",
      };
      const result = normalizeClaudeRateLimits(raw);
      assert.equal(result[0]!.name, expectedName);
    }
  });

  it("returns -1 percentUsed when utilization is missing and status is allowed", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed" as const,
        rateLimitType: "five_hour" as const,
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result[0]!.percentUsed, -1);
  });

  it("returns 75 when utilization is missing and status is allowed_warning", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "allowed_warning" as const,
        rateLimitType: "five_hour" as const,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result[0]!.percentUsed, 75);
  });

  it("returns 100 when status is rejected", () => {
    const raw = {
      type: "rate_limit_event" as const,
      rate_limit_info: {
        status: "rejected" as const,
        rateLimitType: "five_hour" as const,
      },
      uuid: "test-uuid",
      session_id: "test-session",
    };
    const result = normalizeClaudeRateLimits(raw);
    assert.equal(result[0]!.percentUsed, 100);
  });

  it("returns empty array for unknown payload shape", () => {
    const result = normalizeClaudeRateLimits({ unexpected: true });
    assert.equal(result.length, 0);
  });
});

describe("normalizeCodexRateLimits", () => {
  it("returns empty array for unknown payload", () => {
    const result = normalizeCodexRateLimits({ unknown: true });
    assert.equal(result.length, 0);
  });
});
