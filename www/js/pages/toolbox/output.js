// Limit retained browser text independently of server chunk sizes and job duration.
export const MAX_DIAG_TEXT = 262144;

export function retainOutput(text, chunk) {
  const left = Math.max(0, MAX_DIAG_TEXT - text.length);
  return {
    text: text + String(chunk ?? '').slice(0, left),
    limited: String(chunk ?? '').length >= left,
  };
}
