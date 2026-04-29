import type { ProviderKind } from "@codewithme/contracts";

export interface DiscoveredSessionRecord {
  readonly provider: ProviderKind;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly messageCount: number;
  readonly firstActiveAt: string;
  readonly lastActiveAt: string;
  readonly fileSize: number;
  readonly filePath: string;
}
