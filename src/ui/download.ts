/**
 * Hand a generated file to the user: the share sheet where there is one (iOS, so a bundle can
 * be AirDropped straight to another device), else a download link. Browser-only; nothing in
 * `tests/` imports this module.
 */

/** True when the browser can share this file through the system share sheet. */
export function canShareFile(file: File): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
}

/** Trigger a download of `file` through a temporary object URL. */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari needs the URL alive until the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Share the file if the platform offers a share sheet for files, else download it. A share the
 * user dismisses is not an error and does not fall back to a download.
 */
export async function shareOrDownload(file: File): Promise<void> {
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: file.name })
      return
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.warn('Share failed; downloading instead', err)
    }
  }
  downloadFile(file)
}
