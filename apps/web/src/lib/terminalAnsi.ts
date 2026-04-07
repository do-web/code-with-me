/**
 * Terminal output classification utilities for the collapsed terminal bar.
 *
 * Strips ANSI once and extracts both the last meaningful line and
 * warning/error counts in a single pass.
 */

import { stripAnsi } from "@codewithme/shared/ansi";

const WARNING_PATTERNS: RegExp[] = [/\bwarn(ing)?[:\s]/i, /\bWARN\b/];

const ERROR_PATTERNS: RegExp[] = [
  /\berr(or)?[:\s]/i,
  /\bERR[!]\b/,
  /\bfatal[:\s]/i,
  /\bFAILED\b/i,
  /\bException\b/,
  /\bpanic[:\s]/i,
];

export interface OutputAnalysis {
  lastLine: string | null;
  warnings: number;
  errors: number;
}

export function analyzeOutput(text: string): OutputAnalysis {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  let lastLine: string | null = null;
  let warnings = 0;
  let errors = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0) continue;
    if (lastLine === null) lastLine = trimmed;
    if (WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) warnings++;
    if (ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) errors++;
  }
  return { lastLine, warnings, errors };
}

export function extractLastLine(text: string): string | null {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
