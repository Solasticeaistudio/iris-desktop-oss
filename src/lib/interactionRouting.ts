export interface ScreenCaptureRequest {
  displayIndex: number;
}

export function isDeterministicMockToolCommand(input: string): boolean {
  return /^mock tool:\s*[a-z0-9_]+(?:\s+\{.*\})?\s*$/i.test(input.trim());
}

export function parseSpeakRequest(input: string): string | null {
  const match = input.trim().match(
    /^(?:(?:um+|uh+|er+|please)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:say|repeat(?:\s+after\s+me)?)[,:]?\s+(.+?)\s*$/i,
  );
  const phrase = match?.[1]?.trim();
  if (!phrase) return null;
  const generic = phrase.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (['something', 'anything', 'it', 'that', 'something to me', 'anything to me'].includes(generic)) {
    return null;
  }
  return phrase;
}

export function isNonSpeechTranscript(input: string): boolean {
  let remaining = input.trim();
  if (!remaining) return true;
  while (remaining) {
    const closing = remaining.startsWith('[') ? ']' : remaining.startsWith('(') ? ')' : null;
    if (!closing) return false;
    const end = remaining.indexOf(closing, 1);
    if (end < 2 || end > 81 || /[\r\n]/.test(remaining.slice(1, end))) return false;
    remaining = remaining.slice(end + 1).trimStart().replace(/^[,.!?-]+\s*/, '');
  }
  return true;
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
