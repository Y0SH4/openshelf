import { apiFetch, readError } from "@/lib/api"

/** Language that selected text is translated into */
export const TRANSLATE_TO = { code: "id", name: "Indonesian" }

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  id: "Indonesian",
}

export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code.toUpperCase()

let enabledPromise: Promise<boolean> | null = null

/** Whether this server has LibreTranslate set up (asked once per page load). */
export function translationEnabled(): Promise<boolean> {
  enabledPromise ??= apiFetch("/api/translate")
    .then((res) => (res.ok ? res.json() : { enabled: false }))
    .then((data: { enabled?: boolean }) => data.enabled === true)
    .catch(() => false)
  return enabledPromise
}

export interface Translation {
  translated: string
  /** Detected language of the original text */
  source: string | null
}

export async function translate(text: string, signal?: AbortSignal): Promise<Translation> {
  const res = await apiFetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target: TRANSLATE_TO.code }),
    signal,
  })
  if (!res.ok) throw new Error(await readError(res, `Translation failed (${res.status})`))
  return res.json()
}

/** Fallback without a translation server */
export function googleTranslateUrl(text: string): string {
  const params = new URLSearchParams({ sl: "auto", tl: TRANSLATE_TO.code, text, op: "translate" })
  return `https://translate.google.com/?${params}`
}
