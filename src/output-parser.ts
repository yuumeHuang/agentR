// Pure utility functions for parsing R process output.
// No state, no side effects — all functions are deterministic.

export const DONE_MARKER = "___MCP_DONE___";
export const CONT_MARKER = "___MCP_CONT___";
export const ERROR_MARKER = "___MCP_ERROR___";

export const MAX_OUTPUT_LENGTH = 10000;
export const TRUNCATION_NOTICE =
  "\n... [output truncated, use head() or str() to preview]";

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\](){};?*#0-9A-Za-z]*[A-Za-z@]/g;

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export interface ParsedOutput {
  output: string; // Clean stdout output
  error: string | null; // Error messages (if any)
  truncated: boolean; // Whether output was truncated
  incomplete: boolean; // Whether R is waiting for more input
}

/**
 * Parse raw R stdout into a structured result.
 *
 * Raw output may contain:
 *   - ANSI escape codes
 *   - Windows carriage returns (\r)
 *   - One of our sentinel markers at the end (DONE_MARKER or CONT_MARKER)
 *   - Error lines like "Error in ..." or "Error:"
 *   - Excessive output that needs truncation
 */
export function parseOutput(raw: string): ParsedOutput {
  // Step 1: Strip ANSI codes
  let cleaned = stripAnsi(raw);

  // Step 2: Remove carriage returns (Windows)
  cleaned = cleaned.replace(/\r/g, "");

  // Step 3: Detect and remove the sentinel marker
  let incomplete = false;

  if (cleaned.includes(CONT_MARKER)) {
    incomplete = true;
    cleaned = cleaned.replace(CONT_MARKER, "");
  }

  if (cleaned.includes(DONE_MARKER)) {
    cleaned = cleaned.replace(DONE_MARKER, "");
  }

  if (cleaned.includes(ERROR_MARKER)) {
    cleaned = cleaned.replace(ERROR_MARKER, "");
  }

  // Step 4: Trim trailing whitespace but preserve leading whitespace
  cleaned = cleaned.replace(/[ \t]+$/gm, "").trimEnd();

  // Step 5: Extract error lines from the output
  let error: string | null = null;

  // Collect lines that look like R errors
  const errorLines: string[] = [];
  const lines = cleaned.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Error in") ||
      trimmed.startsWith("Error:") ||
      trimmed.startsWith("Error :")
    ) {
      errorLines.push(trimmed);
    }
  }

  if (errorLines.length > 0) {
    error = errorLines.join("\n");
  }

  // Step 6: Truncate if needed
  let truncated = false;
  if (cleaned.length > MAX_OUTPUT_LENGTH) {
    cleaned = cleaned.substring(0, MAX_OUTPUT_LENGTH) + TRUNCATION_NOTICE;
    truncated = true;
  }

  return {
    output: cleaned,
    error,
    truncated,
    incomplete,
  };
}

/**
 * Build the R startup initialization code.
 * This configures custom prompt markers so we can detect when R finishes
 * executing and when it needs more input.
 */
export function buildStartupCode(): string {
  // CRITICAL: Must be a single line for PTY/SSH compatibility.
  // PTY processes input line-by-line; multi-line startup causes the prompt
  // marker to appear before all initialization completes.
  return `options(prompt="${DONE_MARKER}\\n", continue="${CONT_MARKER}\\n"); options(show.error.locations=TRUE); options(warn=1); cat("R session ready\\n")`;
}
