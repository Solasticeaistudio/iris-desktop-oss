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

export function parseScreenVisionRequest(input: string): ScreenCaptureRequest | null {
  const normalized = input.trim().replace(/[.!?]+$/, '').trim();
  const screenTarget = /\b(?:screenshot|screen|monitor|display|desktop)\b/i;
  if (!screenTarget.test(normalized)) return null;

  const asksForVisualUnderstanding = [
    /\b(?:can|could|do|would)\s+you\s+see\b/i,
    /\bwhat(?:'s|\s+is|\s+do\s+you\s+see).*\b(?:screen|monitor|display|desktop)\b/i,
    /\b(?:describe|inspect|analy[sz]e|read|look\s+at)\b.*\b(?:screen|monitor|display|desktop)\b/i,
    /\btell\s+me\s+what.*\b(?:screen|monitor|display|desktop)\b/i,
    /\b(?:take|capture|attach|grab)\b.*\bscreenshot\b.*\b(?:describe|explain|analy[sz]e|tell)\b/i,
  ].some((pattern) => pattern.test(normalized));
  if (!asksForVisualUnderstanding) return null;

  const afterTarget = normalized.match(/\b(?:screen|monitor|display)\s*(\d+)\b/i);
  const beforeTarget = normalized.match(/\b(\d+)(?:st|nd|rd|th)?\s+(?:screen|monitor|display)\b/i);
  const requested = Number(afterTarget?.[1] || beforeTarget?.[1] || 1);
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  return { displayIndex: requested - 1 };
}
