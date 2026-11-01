// Wrapper for PDF.js ES module loaded from @/vendor/pdfjs/

export interface PDFDocumentProxy {
  numPages: number
  getPage: (pageNumber: number) => Promise<PDFPageProxy>
  destroy: () => Promise<void>
}

export interface PDFPageProxy {
  pageNumber: number
  getViewport: (params: { scale: number; rotation?: number }) => {
    width: number
    height: number
  }
  streamTextContent: () => ReadableStream
  render: (params: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }) => {
    promise: Promise<void>
    cancel: () => void
  }
}

let pdfjsPromise: Promise<any> | null = null

export async function getPdfJs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // @ts-ignore
      const [pdfjs, workerUrlModule] = await Promise.all([
        // @ts-ignore
        import("@/vendor/pdfjs/pdf.min.mjs"),
        // @ts-ignore
        import("@/vendor/pdfjs/pdf.worker.min.mjs?url"),
      ])
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrlModule.default || workerUrlModule
      return pdfjs
    })()
  }
  return pdfjsPromise
}

/** `total` is 0 when the server doesn't say how big the file is. */
export type LoadProgress = (loaded: number, total: number) => void

export async function loadPdfDocument(
  url: string,
  onProgress?: LoadProgress
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs()
  const loadingTask = pdfjs.getDocument({
    url,
    cMapPacked: true,
  })
  if (onProgress) {
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total?: number }) =>
      onProgress(loaded, total ?? 0)
  }
  return loadingTask.promise
}
