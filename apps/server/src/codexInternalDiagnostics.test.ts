import { describe, it, assert } from "@effect/vitest";

import {
  isCodexInternalDiagnosticText,
  sanitizeCodexConversationText,
} from "./codexInternalDiagnostics.ts";

describe("codexInternalDiagnostics", () => {
  it("detects EDE diagnostic frames", () => {
    assert.isTrue(
      isCodexInternalDiagnosticText(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    );
  });

  it("ignores ordinary user text", () => {
    assert.isFalse(isCodexInternalDiagnosticText("please continue with the fix"));
  });

  it("strips diagnostic frames from outgoing conversation text", () => {
    assert.equal(
      sanitizeCodexConversationText(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
      "",
    );
  });
});
