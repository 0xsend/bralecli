/** Builtin-only Markdown helpers for summaries that quote externally supplied names. */

/**
 * Renders a name as an inline code span, so it cannot add links, mentions, images,
 * or HTML to a pull request body or run summary. Characters that could end the span,
 * break the line, or visually reorder text are replaced, and long names are shortened.
 */
export function code(name: string, maxLength = 120): string {
  const clean = name.replace(/[`|\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, '\ufffd')
  return `\`${clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean}\``
}

/** Collects Markdown lines until a character budget is reached, then notes the truncation. */
export class BoundedLines {
  readonly #lines: string[] = []
  readonly #budget: number
  readonly #notice: string
  #size = 0
  #truncated = false

  constructor(budget: number, notice: string) {
    this.#budget = budget
    this.#notice = notice
  }

  push(...lines: string[]): boolean {
    for (const line of lines) {
      if (this.#truncated) return false
      if (this.#size + line.length + 1 > this.#budget) {
        this.#truncated = true
        return false
      }
      this.#lines.push(line)
      this.#size += line.length + 1
    }
    return true
  }

  toString(): string {
    return `${[...this.#lines, ...(this.#truncated ? ['', this.#notice] : [])].join('\n')}\n`
  }
}
