import { apiFetch, readError } from "@/lib/api"

/**
 * The notes page is stored as plain Markdown, one block per line:
 *
 *   # Heading        ## Heading 2     ### Heading 3
 *   - Bullet         1. Numbered      - [ ] To-do / - [x] Done
 *   > Quote          ---              Plain text
 *
 * List items are indented with two spaces per level. Inline: **bold**,
 * *italic*, `code`, [label](https://…) and page links
 * [Atomic Habits, p. 17](book:<id>?page=17).
 */

export type BlockType =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "number"
  | "todo"
  | "quote"
  | "divider"

export interface Block {
  id: string
  type: BlockType
  /** Inline Markdown */
  text: string
  indent: number
  checked: boolean
  /** Bumped whenever `text` is changed by code (not typing), so the
   *  editable element re-renders its content. */
  rev: number
}

export const MAX_INDENT = 3
export const LIST_TYPES: BlockType[] = ["bullet", "number", "todo"]

let nextId = 0
export const newBlockId = () => `b${++nextId}`

export function makeBlock(type: BlockType = "p", text = "", indent = 0): Block {
  return { id: newBlockId(), type, text, indent, checked: false, rev: 0 }
}

// ---------------------------------------------------------------------------
// Blocks <-> Markdown
// ---------------------------------------------------------------------------

const BLOCK_PREFIX = /^(#{1,3} |[-*] |\d+\. |> |\[[ xX]?\] |---$)/

export function parseNotes(markdown: string): Block[] {
  const blocks = markdown.split(/\r?\n/).map(parseLine)
  return blocks.length > 0 ? blocks : [makeBlock()]
}

function parseLine(raw: string): Block {
  const spaces = raw.match(/^ */)![0].length
  const line = raw.slice(spaces)
  const indent = Math.min(MAX_INDENT, Math.floor(spaces / 2))
  let m: RegExpMatchArray | null

  if (line.trim() === "---") return makeBlock("divider")
  if ((m = line.match(/^(#{1,3}) (.*)$/)))
    return makeBlock(`h${m[1].length}` as BlockType, m[2])
  if ((m = line.match(/^[-*] \[([ xX])\] (.*)$/))) {
    const block = makeBlock("todo", m[2], indent)
    block.checked = m[1] !== " "
    return block
  }
  if ((m = line.match(/^[-*] (.*)$/))) return makeBlock("bullet", m[1], indent)
  if ((m = line.match(/^\d+\. (.*)$/))) return makeBlock("number", m[1], indent)
  if (line === ">") return makeBlock("quote")
  if ((m = line.match(/^> (.*)$/))) return makeBlock("quote", m[1])
  return makeBlock("p", line)
}

export function serializeNotes(blocks: Block[]): string {
  const numbers = listNumbers(blocks)
  return blocks
    .map((b, i) => {
      const pad = LIST_TYPES.includes(b.type) ? "  ".repeat(b.indent) : ""
      switch (b.type) {
        case "h1":
          return `# ${b.text}`
        case "h2":
          return `## ${b.text}`
        case "h3":
          return `### ${b.text}`
        case "bullet":
          return `${pad}- ${b.text}`
        case "number":
          return `${pad}${numbers[i]}. ${b.text}`
        case "todo":
          return `${pad}- [${b.checked ? "x" : " "}] ${b.text}`
        case "quote":
          return `> ${b.text}`
        case "divider":
          return "---"
        default:
          // Plain text that looks like a block marker gets a backslash
          return BLOCK_PREFIX.test(b.text) || /^ /.test(b.text) ? `\\${b.text}` : b.text
      }
    })
    .join("\n")
    .replace(/\n+$/, "")
}

/** Numbers shown in front of "1." items, per block (0 for other types). */
export function listNumbers(blocks: Block[]): number[] {
  const counters: number[] = []
  return blocks.map((b) => {
    const level = LIST_TYPES.includes(b.type) ? b.indent : 0
    counters.length = level + 1
    if (b.type === "number") {
      counters[level] = (counters[level] ?? 0) + 1
      return counters[level]
    }
    counters[level] = 0
    return 0
  })
}

// ---------------------------------------------------------------------------
// Inline Markdown <-> HTML
// ---------------------------------------------------------------------------

export interface PageLink {
  bookId: string
  page: number
}

export function pageLinkHref({ bookId, page }: PageLink): string {
  return `book:${bookId}?page=${page}`
}

export function parsePageLink(href: string): PageLink | null {
  const m = href.match(/^book:([^?\s]+)\?page=(\d+)$/)
  return m ? { bookId: m[1], page: Number(m[2]) } : null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const escapeInline = (s: string) => s.replace(/([\\*`[\]])/g, "\\$1")

/** Finds the index of `close` in `s` from `from`, skipping escaped characters. */
function findClose(s: string, close: string, from: number): number {
  for (let i = from; i <= s.length - close.length; i++) {
    if (s[i] === "\\") {
      i++
      continue
    }
    if (s.startsWith(close, i)) return i
  }
  return -1
}

export function inlineToHtml(md: string): string {
  let out = ""
  let i = 0
  while (i < md.length) {
    const c = md[i]
    if (c === "\\" && i + 1 < md.length) {
      out += escapeHtml(md[i + 1])
      i += 2
      continue
    }
    if (md.startsWith("**", i)) {
      const end = findClose(md, "**", i + 2)
      if (end > i + 2) {
        out += `<b>${inlineToHtml(md.slice(i + 2, end))}</b>`
        i = end + 2
        continue
      }
    }
    if (c === "*") {
      const end = findClose(md, "*", i + 1)
      if (end > i + 1) {
        out += `<i>${inlineToHtml(md.slice(i + 1, end))}</i>`
        i = end + 1
        continue
      }
    }
    if (c === "`") {
      const end = md.indexOf("`", i + 1)
      if (end > i + 1) {
        out += `<code>${escapeHtml(md.slice(i + 1, end))}</code>`
        i = end + 1
        continue
      }
    }
    if (c === "[") {
      const labelEnd = findClose(md, "]", i + 1)
      if (labelEnd > i && md[labelEnd + 1] === "(") {
        const hrefEnd = md.indexOf(")", labelEnd + 2)
        if (hrefEnd > labelEnd) {
          const label = md.slice(i + 1, labelEnd)
          const href = md.slice(labelEnd + 2, hrefEnd)
          const html = linkHtml(label, href)
          if (html) {
            out += html
            i = hrefEnd + 1
            continue
          }
        }
      }
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

function linkHtml(label: string, href: string): string | null {
  const page = parsePageLink(href)
  if (page) {
    return (
      `<a class="note-chip" contenteditable="false" data-book="${escapeHtml(page.bookId)}" ` +
      `data-page="${page.page}">${inlineToHtml(label)}</a>`
    )
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    return `<a class="note-link" href="${escapeHtml(href)}">${inlineToHtml(label)}</a>`
  }
  return null
}

/** Reads the inline Markdown back out of an editable element (or fragment). */
export function nodesToInline(nodes: NodeListOf<ChildNode> | ChildNode[]): string {
  let out = ""
  for (const node of Array.from(nodes)) out += nodeToInline(node)
  return out
}

function nodeToInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeInline((node.textContent ?? "").replace(/ /g, " ").replace(/\n/g, " "))
  }
  if (!(node instanceof HTMLElement)) return ""
  const inner = () => nodesToInline(node.childNodes)
  const wrap = (mark: string) => {
    const text = inner()
    return text.trim() ? `${mark}${text}${mark}` : text
  }

  switch (node.tagName) {
    case "BR":
      return ""
    case "B":
    case "STRONG":
      return wrap("**")
    case "I":
    case "EM":
      return wrap("*")
    case "CODE": {
      const text = (node.textContent ?? "").replace(/`/g, "")
      return text ? `\`${text}\`` : ""
    }
    case "A": {
      const { book, page } = node.dataset
      if (book && page) {
        return `[${escapeInline(node.textContent ?? "")}](${pageLinkHref({ bookId: book, page: Number(page) })})`
      }
      const href = node.getAttribute("href")
      return href ? `[${inner()}](${href})` : inner()
    }
    default: {
      // Browsers sometimes add <span style="font-weight: bold"> etc.
      const weight = node.style.fontWeight
      if (weight === "bold" || Number(weight) >= 600) return wrap("**")
      if (node.style.fontStyle === "italic") return wrap("*")
      return inner()
    }
  }
}

/** "Atomic Habits, p. 17" link in Markdown. */
export function pageLinkMarkdown(title: string, link: PageLink): string {
  return `[${escapeInline(`${title}, p. ${link.page}`)}](${pageLinkHref(link)})`
}

// ---------------------------------------------------------------------------
// The list of notes
// ---------------------------------------------------------------------------

export interface NoteSummary {
  id: number
  title: string
  /** Start of the content, as Markdown */
  excerpt: string
  updated_at: string | null
}

/** Card preview: the excerpt as one line of plain text. */
export function plainExcerpt(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(#{1,3} |[-*] \[[ xX]\] |[-*] |\d+\. |> ?|---$)/, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\\(.)/g, "$1")
        .replace(/[*`]/g, "")
    )
    .filter(Boolean)
    .join(" · ")
}

/** "14:05" today, "Oct 30" this year, else "Oct 30, 2025". */
export function formatNoteDate(sqliteUtc: string | null): string {
  if (!sqliteUtc) return ""
  const date = new Date(`${sqliteUtc.replace(" ", "T")}Z`)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })
}

/** Creates a note and returns its id. */
export async function createNote(title = ""): Promise<number> {
  const res = await apiFetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(await readError(res, `Couldn't create a note (${res.status})`))
  return (await res.json()).id
}

const LAST_NOTE_KEY = "openshelf_last_note"

/** The note opened most recently on this device (quotes go there by default). */
export function readLastNoteId(): number | null {
  try {
    const id = Number(localStorage.getItem(LAST_NOTE_KEY))
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function storeLastNoteId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(LAST_NOTE_KEY)
    else localStorage.setItem(LAST_NOTE_KEY, String(id))
  } catch {
    // ignore
  }
}
