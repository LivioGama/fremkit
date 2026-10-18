import { nextTick } from 'vue'
import { setSectionsOpen } from '../shared/ui/BaseSection.vue'
import type { MenuUi } from './canvasMenu'

/**
 * Moving the eye to a part of the editor, for the commands a menu cannot finish by itself: a
 * colour is picked in the inspector, a widget is chosen in the library.
 */
export const editorFocus: MenuUi = {
  /** Opens the inspector section `id` and scrolls it into view. '' only brings the inspector up. */
  revealSection(id: string): void {
    if (!id) return
    setSectionsOpen([id], true)
    void nextTick(() => {
      document.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  },
  focusLibrarySearch(): void {
    const input = document.querySelector<HTMLInputElement>('[data-library-search] input')
    input?.focus()
    input?.select()
  },
}
