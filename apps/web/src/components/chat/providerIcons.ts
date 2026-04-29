import type { ProviderKind } from "@codewithme/contracts";
import type { ProviderPickerKind } from "../../session-logic";
import { ClaudeAI, CursorIcon, Gemini, type Icon, OpenAI } from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  gemini: Gemini,
  cursor: CursorIcon,
};

export function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  if (provider === "claudeAgent") return "text-[#d97757]";
  if (provider === "gemini") return "text-[#4285f4]";
  return fallbackClassName;
}
