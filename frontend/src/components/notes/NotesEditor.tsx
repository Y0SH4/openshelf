import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  Bold,
  Check,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  TextQuote,
  Trash2,
  Type,
} from "lucide-react"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  LIST_TYPES,
  MAX_INDENT,
  escapeInline,
  inlineToHtml,
  listNumbers,
  makeBlock,
  nodesToInline,
  pageLinkMarkdown,
  parseNotes,
  serializeNotes,
  type Block,
  type BlockType,
  type PageLink,
} from "@/lib/notes"

export interface NotesEditorHandle {
  /** Inserts "Title, p. 17" at the caret (or at the end of the notes). */
  insertPageLink: (title: string, link: PageLink) => void
  /** Adds a quote block with a page link after the current block. */
  insertQuote: (quote: string, title: string, link: PageLink) => void
}

interface NotesEditorProps {
  ref?: React.Ref<NotesEditorHandle>
  noteId: number
  /** Called after the note was deleted (here or elsewhere). */
  onDeleted: () => void
  /** Opens a book at a page. Returns false if the book isn't in the library. */
  onOpenPage: (link: PageLink) => boolean
  /** Extra buttons at the end of the toolbar */
  toolbarExtra?: React.ReactNode
  /** Classes for the toolbar, e.g. its sticky offset */
  toolbarClassName?: string
}

interface ServerNote {
  id: number
  title: string
  content: string
  version: number
}

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict"
type CaretTarget = "start" | "end" | number
interface PendingFocus {
  id: string
  at: CaretTarget
  /** Only scroll the block into view (don't open the keyboard on phones) */
  scrollOnly?: boolean
}

const SAVE_DELAY_MS = 800
const RETRY_DELAY_MS = 5000
const KEEPALIVE_LIMIT = 60_000

// ---------------------------------------------------------------------------
// Caret helpers
// ---------------------------------------------------------------------------

function selectionIn(el: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return el.contains(range.startContainer) && el.contains(range.endContainer) ? range : null
}

function isBlank(node: { textContent: string | null; querySelector: (s: string) => Element | null }) {
  return (node.textContent ?? "") === "" && !node.querySelector("a")
}

/** True when nothing but `edge` lies between the caret and that edge of `el`. */
function caretAtEdge(el: HTMLElement, edge: "start" | "end"): boolean {
  const range = selectionIn(el)
  if (!range || !range.collapsed) return false
  const rest = document.createRange()
  rest.selectNodeContents(el)
  if (edge === "start") rest.setEnd(range.startContainer, range.startOffset)
  else rest.setStart(range.endContainer, range.endOffset)
  return isBlank(rest.cloneContents())
}

/** Is the caret on the first/last visual line of `el`? */
function caretOnEdgeLine(el: HTMLElement, edge: "first" | "last"): boolean {
  const range = selectionIn(el)
  if (!range || !range.collapsed) return false
  const rect = range.getClientRects()[0]
  if (!rect || (rect.top === 0 && rect.bottom === 0)) {
    return caretAtEdge(el, edge === "first" ? "start" : "end")
  }
  const box = el.getBoundingClientRect()
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24
  return edge === "first"
    ? rect.top - box.top < lineHeight * 0.75
    : box.bottom - rect.bottom < lineHeight * 0.75
}

function placeCaret(el: HTMLElement, at: CaretTarget) {
  el.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(at === "start")
  if (typeof at === "number") {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let remaining = at
    let node: Node | null
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0
      if (remaining <= len && !node.parentElement?.closest(".note-chip")) {
        range.setStart(node, remaining)
        range.collapse(true)
        break
      }
      remaining -= len
    }
  }
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  el.closest(".note-row")?.scrollIntoView({ block: "nearest" })
}

/** Removes everything after the caret from `el` and returns it as Markdown. */
function cutAfterCaret(el: HTMLElement, range: Range): string {
  range.deleteContents()
  const tail = document.createRange()
  tail.selectNodeContents(el)
  tail.setStart(range.startContainer, range.startOffset)
  return nodesToInline(Array.from(tail.extractContents().childNodes))
}

// ---------------------------------------------------------------------------
// Markdown shortcuts typed at the start of a block
// ---------------------------------------------------------------------------

const SHORTCUTS: { pattern: RegExp; type: BlockType; from: BlockType[] }[] = [
  { pattern: /^# $/, type: "h1", from: ["p"] },
  { pattern: /^## $/, type: "h2", from: ["p"] },
  { pattern: /^### $/, type: "h3", from: ["p"] },
  { pattern: /^[-*] $/, type: "bullet", from: ["p"] },
  { pattern: /^1[.)] $/, type: "number", from: ["p"] },
  { pattern: /^\[ ?\] $/, type: "todo", from: ["p", "bullet"] },
  { pattern: /^[>"] $/, type: "quote", from: ["p"] },
]

const PLACEHOLDERS: Partial<Record<BlockType, string>> = {
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  bullet: "List",
  number: "List",
  todo: "To-do",
  quote: "Quote",
}

const TEXT_STYLES: Record<BlockType, string> = {
  p: "",
  h1: "font-serif text-[1.75rem] font-bold leading-tight",
  h2: "font-serif text-[1.4rem] font-bold leading-snug",
  h3: "font-serif text-lg font-bold leading-snug",
  bullet: "",
  number: "",
  todo: "",
  quote: "font-serif italic",
  divider: "",
}

const ROW_SPACING: Partial<Record<BlockType, string>> = {
  h1: "mt-6",
  h2: "mt-4",
  h3: "mt-3",
}

const BULLETS = ["•", "◦", "▪", "•"]

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

interface BlockActions {
  setType: (id: string, type: BlockType) => void
  register: (id: string, el: HTMLDivElement | null) => void
  onInput: (id: string) => void
  onKeyDown: (id: string, e: React.KeyboardEvent<HTMLDivElement>) => void
  onPaste: (id: string, e: React.ClipboardEvent<HTMLDivElement>) => void
  onFocus: (id: string) => void
  onToggle: (id: string) => void
}

interface BlockRowProps {
  block: Block
  number: number
  placeholder: string
  hintOnFocus: boolean
  actions: BlockActions
}

const BlockRow: React.FC<BlockRowProps> = React.memo(
  ({ block, number, placeholder, hintOnFocus, actions }) => {
    const ref = useRef<HTMLDivElement>(null)
    const { id, type, text, rev, indent, checked } = block

    useLayoutEffect(() => {
      actions.register(id, ref.current)
      return () => actions.register(id, null)
    }, [id, actions])

    const textRef = useRef(text)
    useLayoutEffect(() => {
      textRef.current = text
    })
    // Only on mount and when code (not typing) changed the text
    useLayoutEffect(() => {
      if (ref.current) ref.current.innerHTML = inlineToHtml(textRef.current)
    }, [rev])

    if (type === "divider") {
      return (
        <div className="note-row py-3" contentEditable={false}>
          <hr className="border-t border-foreground" />
        </div>
      )
    }

    const isList = LIST_TYPES.includes(type)
    return (
      <div
        className={cn("note-row flex items-start gap-1.5 py-[3px]", ROW_SPACING[type])}
        style={isList ? { paddingLeft: `${indent * 1.5}rem` } : undefined}
      >
        {type === "bullet" && (
          <span className="w-5 shrink-0 text-center leading-[1.6] select-none" aria-hidden>
            {BULLETS[indent] ?? "•"}
          </span>
        )}
        {type === "number" && (
          <span className="min-w-5 shrink-0 text-right pr-0.5 leading-[1.6] tabular-nums select-none">
            {number}.
          </span>
        )}
        {type === "todo" && (
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={checked ? "Mark as not done" : "Mark as done"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => actions.onToggle(id)}
            className={cn(
              "mt-[0.3em] mr-1 w-[1.05rem] h-[1.05rem] shrink-0 border border-foreground flex items-center justify-center",
              checked && "eink-selected"
            )}
          >
            {checked && <Check className="w-3 h-3" strokeWidth={3} />}
          </button>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline={false}
          aria-label={PLACEHOLDERS[type] ?? "Text"}
          data-placeholder={placeholder}
          data-hint={hintOnFocus ? "focus" : "always"}
          onInput={() => actions.onInput(id)}
          onKeyDown={(e) => actions.onKeyDown(id, e)}
          onPaste={(e) => actions.onPaste(id, e)}
          onFocus={() => actions.onFocus(id)}
          className={cn(
            "note-text flex-1 min-w-0 outline-none text-[16px] leading-[1.6] whitespace-pre-wrap break-words",
            TEXT_STYLES[type],
            type === "quote" && "border-l-[3px] border-foreground pl-4",
            type === "todo" && checked && "line-through text-muted-foreground"
          )}
        />
      </div>
    )
  }
)
BlockRow.displayName = "BlockRow"

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/**
 * A Notion-style page: one block per line, Markdown shortcuts
 * ("# ", "- ", "1. ", "[] ", "> ", "---"), Enter / Backspace / Tab like Notion.
 * Loads from and auto-saves to /api/notes/{id}.
 */
export function NotesEditor({
  ref,
  noteId,
  onDeleted,
  onOpenPage,
  toolbarExtra,
  toolbarClassName,
}: NotesEditorProps) {
  const [blocks, setBlocks] = useState<Block[] | null>(null)
  const [title, setTitle] = useState("")
  const [loadError, setLoadError] = useState(false)
  const [missing, setMissing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [conflict, setConflict] = useState<ServerNote | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const blocksRef = useRef<Block[]>([])
  const titleRef = useRef("")
  const disposedRef = useRef(false)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const pendingFocus = useRef<PendingFocus | null>(null)
  const lastFocusedRef = useRef<string | null>(null)
  const versionRef = useRef(0)
  const dirtyRef = useRef(false)
  const conflictRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const queued = useRef<(() => void)[]>([])
  const retryRef = useRef<() => void>(() => {})
  const onOpenPageRef = useRef(onOpenPage)
  useEffect(() => {
    onOpenPageRef.current = onOpenPage
  }, [onOpenPage])

  // ---------- Load & save ----------

  const applyServer = useCallback((note: ServerNote) => {
    const parsed = parseNotes(note.content)
    blocksRef.current = parsed
    titleRef.current = note.title
    setTitle(note.title)
    versionRef.current = note.version
    dirtyRef.current = false
    conflictRef.current = false
    setConflict(null)
    setBlocks(parsed)
    setSaveState("saved")
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/notes/${noteId}`)
      if (res.status === 404) {
        setMissing(true)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      applyServer(await res.json())
      const pending = queued.current
      queued.current = []
      pending.forEach((fn) => fn())
    } catch (err) {
      console.error("Failed to load note:", err)
      setLoadError(true)
    }
  }, [applyServer, noteId])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback((keepalive = false) => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // One request at a time, so each save starts from the latest version
    saveChain.current = saveChain.current.then(async () => {
      if (!dirtyRef.current || conflictRef.current) return
      const body = JSON.stringify({
        title: titleRef.current,
        content: serializeNotes(blocksRef.current),
        base_version: versionRef.current,
      })
      dirtyRef.current = false
      setSaveState("saving")
      try {
        const res = await apiFetch(`/api/notes/${noteId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: keepalive && body.length < KEEPALIVE_LIMIT,
        })
        if (res.status === 409) {
          dirtyRef.current = true
          conflictRef.current = true
          setConflict(await res.json())
          setSaveState("conflict")
          return
        }
        if (res.status === 404) {
          conflictRef.current = true
          setMissing(true)
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const saved: ServerNote = await res.json()
        versionRef.current = saved.version
        setSaveState(dirtyRef.current ? "unsaved" : "saved")
      } catch (err) {
        console.error("Failed to save note:", err)
        dirtyRef.current = true
        setSaveState("error")
        if (!disposedRef.current) {
          timerRef.current = window.setTimeout(() => retryRef.current(), RETRY_DELAY_MS)
        }
      }
    })
  }, [noteId])
  useEffect(() => {
    retryRef.current = () => save()
  }, [save])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (conflictRef.current) return
    setSaveState("unsaved")
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => save(), SAVE_DELAY_MS)
  }, [save])

  // Flush when the editor closes or the tab is hidden
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") save(true)
    }
    const onPageHide = () => save(true)
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("pagehide", onPageHide)
    return () => {
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("pagehide", onPageHide)
      disposedRef.current = true
      save()
    }
  }, [save])

  // ---------- Block updates ----------

  const commit = useCallback(
    (next: Block[], focus?: PendingFocus) => {
      blocksRef.current = next
      if (focus) pendingFocus.current = focus
      setBlocks(next)
      scheduleSave()
    },
    [scheduleSave]
  )

  const indexOf = (id: string) => blocksRef.current.findIndex((b) => b.id === id)

  const replaceAt = (i: number, ...items: Block[]) => {
    const next = blocksRef.current.slice()
    next.splice(i, 1, ...items)
    return next
  }

  useLayoutEffect(() => {
    const focus = pendingFocus.current
    if (!focus) return
    pendingFocus.current = null
    const el = elements.current.get(focus.id)
    if (!el) return
    if (focus.scrollOnly) {
      lastFocusedRef.current = focus.id
      el.closest(".note-row")?.scrollIntoView({ block: "nearest" })
    } else {
      placeCaret(el, focus.at)
    }
  })

  const [actions] = useState<BlockActions>(() => {
    const el = (id: string) => elements.current.get(id)

    const setType = (id: string, type: BlockType) => {
      const i = indexOf(id)
      const b = blocksRef.current[i]
      if (!b) return
      if (type === "divider") {
        const after = blocksRef.current[i + 1]
        const items = [b, makeBlock("divider")]
        let focusId = after?.id
        if (!after || after.type === "divider") {
          const p = makeBlock()
          items.push(p)
          focusId = p.id
        }
        commit(replaceAt(i, ...items), focusId ? { id: focusId, at: "start" } : undefined)
        return
      }
      const nextType = b.type === type ? "p" : type
      commit(replaceAt(i, { ...b, type: nextType, indent: LIST_TYPES.includes(nextType) ? b.indent : 0 }))
    }

    return {
      setType,

      register(id, node) {
        if (node) elements.current.set(id, node)
        else elements.current.delete(id)
      },

      onFocus(id) {
        lastFocusedRef.current = id
        setFocusedId(id)
      },

      onToggle(id) {
        const i = indexOf(id)
        const b = blocksRef.current[i]
        if (b) commit(replaceAt(i, { ...b, checked: !b.checked }))
      },

      onInput(id) {
        const node = el(id)
        const i = indexOf(id)
        const b = blocksRef.current[i]
        if (!node || !b) return
        if (isBlank(node) && node.innerHTML !== "") node.innerHTML = ""

        const range = selectionIn(node)
        if (range && range.collapsed) {
          const before = document.createRange()
          before.selectNodeContents(node)
          before.setEnd(range.startContainer, range.startOffset)
          const typed = before.toString().replace(/ /g, " ")

          if (b.type === "p" && node.textContent === "---") {
            const p = makeBlock()
            commit(replaceAt(i, makeBlock("divider"), p), { id: p.id, at: "start" })
            return
          }
          const rule = SHORTCUTS.find((s) => s.from.includes(b.type) && s.pattern.test(typed))
          if (rule) {
            before.deleteContents()
            const text = nodesToInline(Array.from(node.childNodes))
            commit(replaceAt(i, { ...b, type: rule.type, text, checked: false, rev: b.rev + 1 }), {
              id,
              at: "start",
            })
            return
          }
        }

        const text = nodesToInline(Array.from(node.childNodes))
        if (text !== b.text) commit(replaceAt(i, { ...b, text }))
      },

      onPaste(id, e) {
        const text = e.clipboardData.getData("text/plain")
        e.preventDefault()
        if (!text) return
        if (!/\n/.test(text.trim())) {
          document.execCommand("insertText", false, text.trim())
          return
        }
        const node = el(id)
        const i = indexOf(id)
        const b = blocksRef.current[i]
        const range = node && selectionIn(node)
        if (!node || !b || !range) return

        const after = cutAfterCaret(node, range)
        const before = nodesToInline(Array.from(node.childNodes))
        const pasted = parseNotes(text.replace(/\s+$/, ""))
        const head = { ...b, text: before, rev: b.rev + 1 }
        let rest = pasted
        if (pasted[0].type === "p") {
          head.text = before + pasted[0].text
          rest = pasted.slice(1)
        }
        const items = head.text === "" && b.type === "p" && rest.length ? rest : [head, ...rest]
        let last = items[items.length - 1]
        if (after) {
          if (last.type === "divider") items.push((last = makeBlock("p", after)))
          else items[items.length - 1] = last = { ...last, text: last.text + after, rev: last.rev + 1 }
        }
        commit(replaceAt(i, ...items), { id: last.id, at: "end" })
      },

      onKeyDown(id, e) {
        if (e.nativeEvent.isComposing) return
        const node = el(id)
        const blocks = blocksRef.current
        const i = indexOf(id)
        const b = blocks[i]
        if (!node || !b) return
        const mod = e.metaKey || e.ctrlKey

        if (e.key === "Enter") {
          e.preventDefault()
          const range = selectionIn(node)
          if (!range) return
          const continues = LIST_TYPES.includes(b.type)
          if (isBlank(node) && (continues || b.type === "quote")) {
            const out =
              continues && b.indent > 0
                ? { ...b, indent: b.indent - 1 }
                : { ...b, type: "p" as BlockType, indent: 0 }
            commit(replaceAt(i, out))
            return
          }
          const after = cutAfterCaret(node, range)
          const before = nodesToInline(Array.from(node.childNodes))
          const nextType: BlockType = continues ? b.type : "p"
          if (before === "" && after !== "") {
            const above = makeBlock(nextType, "", b.indent)
            commit(replaceAt(i, above, { ...b, text: after, rev: b.rev + 1 }), { id, at: "start" })
          } else {
            const below = makeBlock(nextType, after, continues ? b.indent : 0)
            commit(replaceAt(i, { ...b, text: before, rev: b.rev + 1 }, below), {
              id: below.id,
              at: "start",
            })
          }
          return
        }

        if (e.key === "Backspace" && !mod && caretAtEdge(node, "start")) {
          if (b.type !== "p") {
            e.preventDefault()
            const out =
              LIST_TYPES.includes(b.type) && b.indent > 0
                ? { ...b, indent: b.indent - 1 }
                : { ...b, type: "p" as BlockType, indent: 0, checked: false }
            commit(replaceAt(i, out))
            return
          }
          if (i === 0) return
          e.preventDefault()
          const prev = blocks[i - 1]
          if (prev.type === "divider") {
            const next = blocks.slice()
            next.splice(i - 1, 1)
            commit(next, { id, at: "start" })
            return
          }
          const offset = el(prev.id)?.textContent?.length ?? 0
          const next = blocks.slice()
          next.splice(i - 1, 2, { ...prev, text: prev.text + b.text, rev: prev.rev + 1 })
          commit(next, { id: prev.id, at: offset })
          return
        }

        if (e.key === "Delete" && caretAtEdge(node, "end") && i < blocks.length - 1) {
          e.preventDefault()
          const nextBlock = blocks[i + 1]
          const offset = node.textContent?.length ?? 0
          const next = blocks.slice()
          if (nextBlock.type === "divider") next.splice(i + 1, 1)
          else next.splice(i, 2, { ...b, text: b.text + nextBlock.text, rev: b.rev + 1 })
          commit(next, { id, at: offset })
          return
        }

        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !mod) {
          const up = e.key === "ArrowUp"
          if (!caretOnEdgeLine(node, up ? "first" : "last")) return
          const step = up ? -1 : 1
          let j = i + step
          while (blocks[j]?.type === "divider") j += step
          const target = blocks[j] && el(blocks[j].id)
          if (!target) return
          e.preventDefault()
          placeCaret(target, up ? "end" : "start")
          return
        }

        if (e.key === "Tab") {
          e.preventDefault()
          if (!LIST_TYPES.includes(b.type)) return
          const prev = blocks[i - 1]
          const maxIndent = prev && LIST_TYPES.includes(prev.type) ? prev.indent + 1 : 0
          const indent = e.shiftKey
            ? Math.max(0, b.indent - 1)
            : Math.min(MAX_INDENT, maxIndent, b.indent + 1)
          if (indent !== b.indent) commit(replaceAt(i, { ...b, indent }))
          return
        }

        if (mod && !e.shiftKey && !e.altKey) {
          const key = e.key.toLowerCase()
          if (key === "b" || key === "i") {
            e.preventDefault()
            document.execCommand(key === "b" ? "bold" : "italic")
          }
        }
      },
    }
  })

  const setType = (type: BlockType) => {
    const id = lastFocusedRef.current
    if (id) actions.setType(id, type)
  }

  // ---------- Inserting from the reader ----------

  const whenLoaded = (fn: () => void) => {
    if (blocksRef.current.length) fn()
    else queued.current.push(fn)
  }

  useImperativeHandle(ref, () => ({
    insertPageLink(title, link) {
      whenLoaded(() => {
        const md = pageLinkMarkdown(title, link)
        const id = lastFocusedRef.current
        const node = id ? elements.current.get(id) : undefined
        const range = node && document.activeElement === node ? selectionIn(node) : null

        if (id && node && range) {
          range.deleteContents()
          const tpl = document.createElement("template")
          tpl.innerHTML = `${inlineToHtml(md)} `
          const end = tpl.content.lastChild
          range.insertNode(tpl.content)
          if (end) {
            range.setStartAfter(end)
            range.collapse(true)
            const sel = window.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
          actions.onInput(id)
          return
        }

        const blocks = blocksRef.current
        const i = id ? indexOf(id) : -1
        const target = blocks[i]
        if (target && target.type !== "divider") {
          const sep = target.text === "" || target.text.endsWith(" ") ? "" : " "
          commit(replaceAt(i, { ...target, text: target.text + sep + md, rev: target.rev + 1 }), {
            id: target.id,
            at: "end",
            scrollOnly: true,
          })
          return
        }
        const last = blocks[blocks.length - 1]
        if (last && last.type === "p" && last.text === "") {
          commit(replaceAt(blocks.length - 1, { ...last, text: md, rev: last.rev + 1 }), {
            id: last.id,
            at: "end",
            scrollOnly: true,
          })
        } else {
          const p = makeBlock("p", md)
          commit([...blocks, p], { id: p.id, at: "end", scrollOnly: true })
        }
      })
    },

    insertQuote(quote, title, link) {
      whenLoaded(() => {
        const text = `${escapeInline(quote.replace(/\s+/g, " ").trim())} ${pageLinkMarkdown(title, link)}`
        const blocks = blocksRef.current
        const quoteBlock = makeBlock("quote", text)
        const onlyEmpty = blocks.length === 1 && blocks[0].type === "p" && blocks[0].text === ""
        const from = lastFocusedRef.current ? indexOf(lastFocusedRef.current) : -1
        const at = onlyEmpty ? 0 : from >= 0 ? from + 1 : blocks.length
        const following = onlyEmpty ? undefined : blocks[at]
        const items = [quoteBlock]
        let focusId: string
        if (following && following.type === "p" && following.text === "") {
          focusId = following.id
        } else {
          const p = makeBlock()
          items.push(p)
          focusId = p.id
        }
        const next = blocks.slice()
        next.splice(at, onlyEmpty ? 1 : 0, ...items)
        commit(next, { id: focusId, at: "start", scrollOnly: true })
      })
    },
  }))

  // ---------- Links ----------

  const handleClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a")
    if (!a) return
    e.preventDefault()
    const { book, page } = a.dataset
    if (book && page) {
      if (!onOpenPageRef.current({ bookId: book, page: Number(page) })) {
        setMessage("That book isn't in your library anymore.")
        window.setTimeout(() => setMessage(null), 4000)
      }
    } else if (a.getAttribute("href")) {
      window.open(a.getAttribute("href")!, "_blank", "noopener,noreferrer")
    }
  }

  // ---------- Title & delete ----------

  const focusFirstBlock = () => {
    const first = blocksRef.current.find((b) => b.type !== "divider")
    const el = first && elements.current.get(first.id)
    if (el) placeCaret(el, "start")
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const atEnd = e.currentTarget.selectionStart === e.currentTarget.value.length
    if (e.key === "Enter" || (e.key === "ArrowDown" && atEnd)) {
      e.preventDefault()
      focusFirstBlock()
    }
  }

  const handleDelete = async () => {
    // Stop saving first, so a pending save can't recreate the note
    if (timerRef.current) window.clearTimeout(timerRef.current)
    conflictRef.current = true
    dirtyRef.current = false
    try {
      const res = await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      onDeleted()
    } catch (err) {
      console.error("Failed to delete note:", err)
      conflictRef.current = false
      setConfirmDelete(false)
      setMessage("Couldn't delete this note. Try again.")
    }
  }

  // ---------- Render ----------

  const resolveConflict = (keepMine: boolean) => {
    if (!conflict) return
    if (keepMine) {
      versionRef.current = conflict.version
      conflictRef.current = false
      setConflict(null)
      dirtyRef.current = true
      save()
    } else {
      applyServer(conflict)
    }
  }

  const focusedType = blocks?.find((b) => b.id === focusedId)?.type
  const numbers = blocks ? listNumbers(blocks) : []
  const statusLabel: Record<SaveState, string> = {
    saved: "Saved",
    unsaved: "Not saved yet",
    saving: "Saving…",
    error: "Couldn't save — retrying",
    conflict: "Not saved",
  }

  const tools: { type: BlockType; label: string; icon: React.ReactNode }[] = [
    { type: "p", label: "Text", icon: <Type className="w-4 h-4" /> },
    { type: "h1", label: "Heading 1", icon: <Heading1 className="w-4 h-4" /> },
    { type: "h2", label: "Heading 2", icon: <Heading2 className="w-4 h-4" /> },
    { type: "h3", label: "Heading 3", icon: <Heading3 className="w-4 h-4" /> },
    { type: "bullet", label: "Bulleted list", icon: <List className="w-4 h-4" /> },
    { type: "number", label: "Numbered list", icon: <ListOrdered className="w-4 h-4" /> },
    { type: "todo", label: "To-do", icon: <ListTodo className="w-4 h-4" /> },
    { type: "quote", label: "Quote", icon: <TextQuote className="w-4 h-4" /> },
    { type: "divider", label: "Divider", icon: <Minus className="w-4 h-4" /> },
  ]
  const toolButton = "h-9 w-9 shrink-0 flex items-center justify-center hover:bg-accent"

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "z-10 bg-background border-b border-rule flex flex-wrap items-center gap-0.5 py-1 px-1",
          toolbarClassName
        )}
        role="toolbar"
        aria-label="Formatting"
        onMouseDown={(e) => {
          // Keep the caret in the editor while clicking toolbar buttons
          if ((e.target as HTMLElement).closest("button")) e.preventDefault()
        }}
      >
        {tools.map((t) => (
          <button
            key={t.type}
            type="button"
            title={t.label}
            aria-label={t.label}
            aria-pressed={t.type !== "divider" && focusedType === t.type}
            onClick={() => setType(t.type)}
            className={cn(toolButton, t.type !== "divider" && focusedType === t.type && "eink-selected")}
          >
            {t.icon}
          </button>
        ))}
        <span className="h-5 w-px bg-rule mx-1 shrink-0" />
        <button
          type="button"
          title="Bold (Ctrl+B)"
          aria-label="Bold"
          onClick={() => document.execCommand("bold")}
          className={toolButton}
        >
          <Bold className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Italic (Ctrl+I)"
          aria-label="Italic"
          onClick={() => document.execCommand("italic")}
          className={toolButton}
        >
          <Italic className="w-4 h-4" />
        </button>
        {toolbarExtra}
        <span
          className={cn(
            "ml-auto pl-3 shrink-0 text-xs",
            saveState === "error" || saveState === "conflict" ? "font-medium" : "text-muted-foreground"
          )}
          role="status"
        >
          {blocks ? statusLabel[saveState] : ""}
        </span>
        <button
          type="button"
          title="Delete note"
          aria-label="Delete note"
          onClick={() => setConfirmDelete(true)}
          disabled={!blocks}
          className={cn(toolButton, "disabled:opacity-30")}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {confirmDelete && (
        <div role="alert" className="mt-4 border-2 border-foreground p-3 text-sm">
          <p className="font-medium">Delete this note? This can't be undone.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleDelete}
              className="h-9 px-3 eink-selected hover:opacity-90"
            >
              Delete note
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="h-9 px-3 border border-foreground hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {conflict && (
        <div role="alert" className="mt-4 border-2 border-foreground p-3 text-sm">
          <p className="font-medium">This note was changed in another tab or device.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => resolveConflict(false)}
              className="h-9 px-3 border border-foreground hover:bg-accent"
            >
              Load the newer version
            </button>
            <button
              type="button"
              onClick={() => resolveConflict(true)}
              className="h-9 px-3 eink-selected hover:opacity-90"
            >
              Keep my version
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className="mt-3 text-sm border border-foreground px-3 py-2">
          {message}
        </p>
      )}

      {missing ? (
        <div className="py-16 text-center">
          <p className="font-serif text-lg">This note was deleted</p>
          <button
            type="button"
            onClick={onDeleted}
            className="mt-4 h-10 px-5 border border-foreground hover:bg-accent text-sm font-medium"
          >
            Back to notes
          </button>
        </div>
      ) : loadError ? (
        <div className="py-16 text-center">
          <p className="font-serif text-lg">Couldn't load this note</p>
          <button
            type="button"
            onClick={() => {
              setLoadError(false)
              load()
            }}
            className="mt-4 h-10 px-5 border border-foreground hover:bg-accent text-sm font-medium"
          >
            Try again
          </button>
        </div>
      ) : !blocks ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading note…</p>
      ) : (
        <div className="notes-body pt-5 pb-[40vh]" onClick={handleClick}>
          <textarea
            value={title}
            onChange={(e) => {
              const value = e.target.value.replace(/\n/g, " ")
              titleRef.current = value
              setTitle(value)
              scheduleSave()
            }}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
            aria-label="Note title"
            rows={1}
            maxLength={200}
            className="w-full resize-none overflow-hidden bg-transparent font-serif text-[2rem] font-bold leading-tight tracking-tight placeholder:text-muted-foreground/50 focus:outline-none mb-3 [field-sizing:content]"
          />
          {blocks.map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              number={numbers[i]}
              placeholder={
                PLACEHOLDERS[b.type] ??
                (blocks.length === 1
                  ? "Start writing… Type # for a heading, - for a list, [] for a to-do"
                  : "Type # - [] > for blocks")
              }
              hintOnFocus={b.type === "p" && blocks.length > 1}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  )
}
