/** The editor context appended to every message, and how the UI strips it again. */
export const CONTEXT_START = '\n\n<compound-context>\n';
export const CONTEXT_END = '\n</compound-context>';

export function splitContext(text: string) {
  const index = text.lastIndexOf(CONTEXT_START);
  if (index < 0 || !text.endsWith(CONTEXT_END)) return { text, context: '' };
  return { text: text.slice(0, index), context: text.slice(index + CONTEXT_START.length, -CONTEXT_END.length) };
}
