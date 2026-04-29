import type { ThreadTurnCompletionStatus } from "@codewithme/contracts";

/**
 * Turn-completion notification plumbing.
 *
 * Kept as a small collection of pure functions plus thin side-effectful
 * wrappers so the decision logic (suppression, content) stays trivially
 * testable without mocking browser APIs.
 */

const FALLBACK_TITLE = "Turn completed";

const STATUS_BODY: Record<ThreadTurnCompletionStatus, string> = {
  completed: "Turn completed",
  failed: "Turn failed",
  interrupted: "Turn interrupted",
  cancelled: "Turn cancelled",
};

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

export function buildNotificationContent(
  status: ThreadTurnCompletionStatus,
  threadTitle: string | null | undefined,
): NotificationContent {
  const trimmed = threadTitle?.trim();
  return {
    title: trimmed && trimmed.length > 0 ? trimmed : FALLBACK_TITLE,
    body: STATUS_BODY[status],
  };
}

export interface SuppressNotificationParams {
  readonly visibilityState: DocumentVisibilityState;
  readonly hasFocus: boolean;
  readonly activeThreadId: string | null;
  readonly eventThreadId: string;
}

/**
 * Suppress a notification when the user is already looking at the thread
 * that just completed. "Already looking" means: tab visible AND focused AND
 * the route's current thread matches the event's thread.
 */
export function shouldSuppressNotification({
  visibilityState,
  hasFocus,
  activeThreadId,
  eventThreadId,
}: SuppressNotificationParams): boolean {
  return visibilityState === "visible" && hasFocus && activeThreadId === eventThreadId;
}

/**
 * Lazy-initialized AudioContext so we don't allocate one on every call nor
 * break SSR. Errors are swallowed on purpose — sound is a nice-to-have.
 */
let cachedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (cachedAudioContext) return cachedAudioContext;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    cachedAudioContext = new Ctor();
    return cachedAudioContext;
  } catch {
    return null;
  }
}

export function playCompletionSound(status: ThreadTurnCompletionStatus): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    // Ramp context if suspended (autoplay policy).
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const now = ctx.currentTime;
    const isSuccess = status === "completed";
    const firstFreq = 660;
    const secondFreq = isSuccess ? 880 : 440;

    playTone(ctx, firstFreq, now, 0.15);
    playTone(ctx, secondFreq, now + 0.16, 0.22);
  } catch {
    // Any failure here is non-fatal — the notification still fires.
  }
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  durationSec: number,
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);

  // Fade-in + fade-out so there's no click artifact.
  const peak = 0.12;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSec);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec + 0.02);
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "denied";
  }
  if (Notification.permission !== "default") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface ShowCompletionNotificationParams {
  readonly threadId: string;
  readonly threadTitle: string | null | undefined;
  readonly status: ThreadTurnCompletionStatus;
}

export function showCompletionNotification({
  threadId,
  threadTitle,
  status,
}: ShowCompletionNotificationParams): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }
  const { title, body } = buildNotificationContent(status, threadTitle);
  try {
    // Browser Notifications are intentionally used for their side effect.
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag: `turn-complete:${threadId}` });
  } catch {
    // Electron / sandboxed contexts may throw — ignore and rely on sound.
  }
}
