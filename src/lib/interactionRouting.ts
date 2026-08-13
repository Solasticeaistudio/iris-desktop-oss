export interface ScreenCaptureRequest {
  displayIndex: number;
}

export function isDeterministicMockToolCommand(input: string): boolean {
  return /^mock tool:\s*[a-z0-9_]+(?:\s+\{.*\})?\s*$/i.test(input.trim());
}

export function parseScreenCaptureRequest(input: string): ScreenCaptureRequest | null {
  const normalized = input.trim().replace(/[.!?]+$/, '').trim();
  const screenshot = normalized.match(
    /^(?:take|capture|attach|grab)(?:\s+a)?\s+screenshot(?:\s+of)?(?:\s+(?:monitor|screen|display)\s*(\d+))?$/i,
  );
  const display = normalized.match(
    /^(?:take|capture|attach|grab)(?:\s+a)?(?:\s+screenshot)?\s+(?:of\s+)?(?:monitor|screen|display)\s*(\d+)$/i,
  );
  const match = screenshot || display;
  if (!match) return null;
  const requested = match[1] ? Number(match[1]) : 1;
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  return { displayIndex: requested - 1 };
}
