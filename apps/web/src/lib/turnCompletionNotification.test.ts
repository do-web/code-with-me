import { describe, expect, it } from "vitest";
import { buildNotificationContent, shouldSuppressNotification } from "./turnCompletionNotification";

describe("buildNotificationContent", () => {
  it("uses the trimmed thread title when present", () => {
    const content = buildNotificationContent("completed", "  Refactor auth  ");
    expect(content.title).toBe("Refactor auth");
    expect(content.body).toBe("Turn completed");
  });

  it("falls back to a generic title when the thread title is missing", () => {
    expect(buildNotificationContent("completed", null).title).toBe("Turn completed");
    expect(buildNotificationContent("completed", undefined).title).toBe("Turn completed");
    expect(buildNotificationContent("completed", "   ").title).toBe("Turn completed");
  });

  it.each([
    ["completed", "Turn completed"],
    ["failed", "Turn failed"],
    ["interrupted", "Turn interrupted"],
    ["cancelled", "Turn cancelled"],
  ] as const)("maps status %s to body %s", (status, body) => {
    expect(buildNotificationContent(status, "Thread").body).toBe(body);
  });
});

describe("shouldSuppressNotification", () => {
  const base = {
    visibilityState: "visible" as DocumentVisibilityState,
    hasFocus: true,
    activeThreadId: "thread-1",
    eventThreadId: "thread-1",
  };

  it("suppresses when the user is actively looking at the thread", () => {
    expect(shouldSuppressNotification(base)).toBe(true);
  });

  it("does not suppress when the tab is hidden", () => {
    expect(shouldSuppressNotification({ ...base, visibilityState: "hidden" })).toBe(false);
  });

  it("does not suppress when the window is unfocused", () => {
    expect(shouldSuppressNotification({ ...base, hasFocus: false })).toBe(false);
  });

  it("does not suppress when a different thread is active", () => {
    expect(shouldSuppressNotification({ ...base, activeThreadId: "thread-2" })).toBe(false);
  });

  it("does not suppress when no thread is active", () => {
    expect(shouldSuppressNotification({ ...base, activeThreadId: null })).toBe(false);
  });
});
