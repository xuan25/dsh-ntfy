// dsh-ntfy body chunking: split a UTF-8 string into pieces of at most maxBytes
// bytes (the ntfy message body limit of 4096), never splitting a codepoint, and
// preferring a cut right after the last newline inside the current window so a
// receiver reading the chunks in order sees complete lines whenever possible.
/**
 * UTF-8 byte length of one codepoint.
 * @param cp a unicode codepoint (0..0x10FFFF).
 * @returns 1-4.
 */
function utf8Len(cp: number): number {
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/**
 * Split a message body into UTF-8 chunks of at most maxBytes bytes each.
 * @param body the message body ("" yields an empty chunk list).
 * @param maxBytes the byte budget per chunk (default 4096, the ntfy body limit).
 * @returns the ordered chunks; concatenating them reproduces the body exactly.
 */
export function chunkUtf8(body: string, maxBytes: number = 4096): string[] {
  const cps = Array.from(body)
  const chunks: string[] = []
  let start = 0
  while (start < cps.length) {
    // Grow the window until the next codepoint would exceed the byte budget.
    let end = start
    let size = 0
    while (end < cps.length) {
      const len = utf8Len(cps[end].codePointAt(0) as number)
      if (end > start && size + len > maxBytes) break
      size += len
      end += 1
    }
    if (end === cps.length) {
      chunks.push(cps.slice(start).join(''))
      break
    }
    // [start, end) overflows the budget: cut after the last newline strictly
    // inside the window when one exists; otherwise cut at the byte boundary.
    let cut = end
    for (let j = end - 1; j > start; j--) {
      if (cps[j] === '\n') {
        cut = j + 1
        break
      }
    }
    if (cut === start) cut = end // guard: the window holds at least one codepoint
    chunks.push(cps.slice(start, cut).join(''))
    start = cut
  }
  return chunks
}
