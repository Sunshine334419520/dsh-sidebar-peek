/**
 * Edge-style hover peek for the DSH left sidebar.
 *
 * The rail (collapsed sidebar) stays as it is. Moving the pointer into the rail
 * — or into a narrow strip at the left edge on platforms that hide the rail —
 * expands the sidebar through the public `ctx.layout.toggleSidebar()` action,
 * and leaving it collapses the sidebar again.
 *
 * In `overlay` mode (default) the expansion does not squeeze the conversation:
 * the frozen grid track keeps the centre column where it was and the sidebar
 * column is lifted out of the grid so it floats above the content, the way a
 * browser's sidebar peeks over the page. `push` mode keeps the host's normal
 * in-flow expansion instead.
 *
 * Tuning lives in localStorage, read once when the module activates:
 *   dsh-sidebar-peek:mode           "overlay" (default) | "push"
 *   dsh-sidebar-peek:delay          dwell before expanding, ms (default 160)
 *   dsh-sidebar-peek:leaveDelay     grace before collapsing, ms (default 280)
 *   dsh-sidebar-peek:startCollapsed "1" (default) collapses the sidebar once
 *                                   after load so it rests as the icon rail;
 *                                   "0" leaves the opening state alone
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-peek',
  factory() {
    /** Sidebar width the host expands to before any drag. */
    const DEFAULT_WIDTH = 280
    /** Width at or above which the collapsed column is a visible icon rail. */
    const RAIL_MIN = 40
    /** Hot edge used where the collapsed column has no rail to hover. */
    const HOT_EDGE = 6
    /** How long the pointer must rest in the zone before the peek opens. */
    const HOVER_DELAY = 160
    /** Grace period before collapsing once the pointer leaves the peel. */
    const LEAVE_DELAY = 280
    /** Time the host needs to fade its wide content out before we detach. */
    const RELEASE_DELAY = 320
    /** Delay between retries while the host animates a track change. */
    const RETRY_DELAY = 120
    const MAX_RETRIES = 6
    /** Poll cadence while waiting for the host to commit its expanded width. */
    const MEASURE_RETRY = 32
    const MAX_MEASURES = 12
    /** Pointer targets that mean "the user changed the sidebar on purpose". */
    const TOGGLE_SELECTOR = '[data-sidebar-toggle],[data-sidebar-opener]'
    /** Surfaces that must not be covered by an automatic expansion. */
    const SURFACE_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"]'

    const STYLE = `
[data-dsh-peek]{grid-template-columns:var(--dsh-peek-grid) !important}
[data-dsh-peek]>[data-side="sidebar"]{pointer-events:none}
[data-dsh-peek-col]{
  position:absolute !important;
  grid-area:auto !important;
  inset:0 auto auto 0 !important;
  height:var(--dsh-peek-height,100%) !important;
  width:var(--dsh-peek-width,${DEFAULT_WIDTH}px) !important;
  z-index:40 !important;
  background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1,#fff)) !important;
  border-right:0.5px solid var(--dsw-alias-border-l3,transparent) !important;
  box-shadow:0 12px 32px -16px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));
  transition:width var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out,ease);
}
@media (prefers-reduced-motion:reduce){[data-dsh-peek-col]{transition:none}}
`

    function setting(key, fallback) {
      try {
        const value = window.localStorage.getItem(`dsh-sidebar-peek:${key}`)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function numberSetting(key, fallback) {
      const value = Number(setting(key, String(fallback)))
      return Number.isFinite(value) && value >= 0 ? value : fallback
    }

    const MODE = setting('mode', 'overlay') === 'push' ? 'push' : 'overlay'
    const OPEN_DELAY = numberSetting('delay', HOVER_DELAY)
    const CLOSE_DELAY = numberSetting('leaveDelay', LEAVE_DELAY)
    const START_COLLAPSED = setting('startCollapsed', '1') !== '0'

    /** Everything the current peek needs to undo itself. */
    const state = {
      /** { frame, col, railWidth } while a peek is open. */
      peek: null,
      /** Generation counter so a stale release cannot strip a newer peek. */
      generation: 0,
      openTimer: 0,
      closeTimer: 0,
      releaseTimer: 0,
      retries: 0,
      /** Suppress auto-open until the pointer leaves the rail after a manual toggle. */
      suppressed: false,
      observer: null,
      /** Memoised shell frame and sidebar column for the per-move handler. */
      frame: null,
      col: null,
    }

    /**
     * The shell frame, memoised because the pointer handler runs per move.
     * A re-mounted shell invalidates the cached frame and column.
     */
    function frameOf() {
      const cached = state.frame
      if (cached !== null && cached.isConnected) return cached
      const layer = document.querySelector('[data-shell-overlay]')
      if (layer === null || layer.parentElement === null) return null
      const frame = layer.parentElement
      if (!(frame instanceof HTMLElement)) return null
      state.frame = frame
      state.col = null
      return frame
    }

    /** The sidebar column: the frame child that holds the rail's toggle control. */
    function columnOf(frame) {
      if (state.frame === frame && state.col !== null && state.col.isConnected) return state.col
      if (state.frame !== frame) {
        state.frame = frame
        state.col = null
      }
      const toggle = frame.querySelector('[data-sidebar-toggle]')
      if (toggle !== null) {
        let node = toggle
        while (node.parentElement !== null && node.parentElement !== frame) node = node.parentElement
        if (node.parentElement === frame) {
          state.col = node
          return node
        }
      }
      const mask = frame.querySelector('[data-sidebar-mask]')
      const fallback = mask !== null ? mask.nextElementSibling : frame.firstElementChild
      if (!(fallback instanceof HTMLElement)) return null
      state.col = fallback
      return fallback
    }

    function isCollapsed(frame) {
      return frame.hasAttribute('data-sidebar-collapsed')
    }

    function clearOpenTimer() {
      if (state.openTimer !== 0) {
        window.clearTimeout(state.openTimer)
        state.openTimer = 0
      }
      state.retries = 0
    }

    function clearCloseTimer() {
      if (state.closeTimer !== 0) {
        window.clearTimeout(state.closeTimer)
        state.closeTimer = 0
      }
    }

    function clearReleaseTimer() {
      if (state.releaseTimer !== 0) {
        window.clearTimeout(state.releaseTimer)
        state.releaseTimer = 0
      }
    }

    /** Detach every attribute and variable this plugin put on the host nodes. */
    function detach(peek) {
      try {
        peek.frame.removeAttribute('data-dsh-peek')
        peek.frame.style.removeProperty('--dsh-peek-grid')
      } catch {}
      try {
        peek.col.removeAttribute('data-dsh-peek-col')
        peek.col.style.removeProperty('--dsh-peek-width')
        peek.col.style.removeProperty('--dsh-peek-height')
      } catch {}
    }

    function observeFrame(peek) {
      if (typeof MutationObserver !== 'function') return
      const observer = new MutationObserver(() => {
        if (state.peek !== peek) return
        // The host collapsed or switched to drawer mode on its own: drop the
        // peek instead of toggling the sidebar again.
        if (isCollapsed(peek.frame) || peek.frame.hasAttribute('data-sidebar-drawer')) {
          state.peek = null
          state.generation += 1
          peek.col.style.setProperty('--dsh-peek-width', `${Math.round(peek.railWidth)}px`)
          const generation = state.generation
          state.releaseTimer = window.setTimeout(() => {
            state.releaseTimer = 0
            if (state.generation === generation) detach(peek)
          }, RELEASE_DELAY)
        }
      })
      observer.observe(peek.frame, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed', 'data-sidebar-drawer'],
      })
      state.observer = observer
    }

    function unobserveFrame() {
      if (state.observer !== null) {
        state.observer.disconnect()
        state.observer = null
      }
    }

    /**
     * Adopt the width the host expanded to. The host animates its own column
     * width, so its box is unusable as a target: read the inline width React
     * commits instead, and only fall back to the settled box.
     */
    function measureWidth(peek, attempt) {
      if (state.peek !== peek) return
      const child = peek.col.firstElementChild
      if (child === null) {
        if (attempt < MAX_MEASURES) window.setTimeout(() => measureWidth(peek, attempt + 1), MEASURE_RETRY)
        return
      }
      const declared = Number.parseFloat(child.style.width)
      if (Number.isFinite(declared) && declared > peek.railWidth + 1) {
        peek.col.style.setProperty('--dsh-peek-width', `${Math.round(declared)}px`)
        return
      }
      // No committed width yet: once the host stops animating, its box is truth.
      if (!peek.frame.hasAttribute('data-animating')) {
        const settled = Math.round(child.getBoundingClientRect().width)
        if (settled > peek.railWidth + 1) {
          peek.col.style.setProperty('--dsh-peek-width', `${settled}px`)
          return
        }
      }
      if (attempt < MAX_MEASURES) {
        window.setTimeout(() => measureWidth(peek, attempt + 1), MEASURE_RETRY)
        return
      }
      // Last resort: a usable width rather than a rail-wide overlay.
      peek.col.style.setProperty('--dsh-peek-width', `${DEFAULT_WIDTH}px`)
    }

    function open(ctx) {
      const frame = frameOf()
      if (frame === null || !isCollapsed(frame)) return true
      if (frame.hasAttribute('data-sidebar-drawer') || frame.hasAttribute('data-dragging')) return true
      // A track transition is running: freezing now would capture its target,
      // not what the user sees.
      if (frame.hasAttribute('data-animating')) return false
      if (!document.hasFocus()) return true
      if (document.querySelector(SURFACE_SELECTOR) !== null) return true
      const col = columnOf(frame)
      if (col === null) return true
      let rect
      try {
        rect = col.getBoundingClientRect()
      } catch {
        return true
      }
      if (rect.width < 0 || rect.height <= 0) return true

      /** @type {{frame: HTMLElement, col: HTMLElement, railWidth: number}} */
      const peek = { frame, col, railWidth: rect.width }
      try {
        if (MODE === 'overlay') {
          // Freeze the collapsed track before the host writes the expanded one,
          // then lift the column out of the grid over the frozen rail.
          peek.frame.style.setProperty('--dsh-peek-grid', peek.frame.style.gridTemplateColumns || 'none')
          peek.frame.setAttribute('data-dsh-peek', '')
          peek.col.setAttribute('data-dsh-peek-col', '')
          peek.col.style.setProperty('--dsh-peek-height', `${Math.round(rect.height)}px`)
          peek.col.style.setProperty('--dsh-peek-width', `${Math.round(rect.width)}px`)
        }
      } catch {
        detach(peek)
        return true
      }

      state.peek = peek
      state.generation += 1
      observeFrame(peek)
      try {
        ctx.layout.toggleSidebar()
      } catch {
        state.peek = null
        unobserveFrame()
        detach(peek)
        return true
      }
      if (MODE === 'overlay') {
        window.setTimeout(() => measureWidth(peek, 0), 0)
      }
      return true
    }

    function scheduleOpen(ctx) {
      if (state.openTimer !== 0) return
      state.openTimer = window.setTimeout(() => {
        state.openTimer = 0
        const done = open(ctx)
        if (!done && state.retries < MAX_RETRIES) {
          state.retries += 1
          scheduleOpen(ctx)
        }
      }, OPEN_DELAY)
    }

    function close(ctx) {
      clearCloseTimer()
      const peek = state.peek
      if (peek === null) return
      state.peek = null
      state.generation += 1
      unobserveFrame()
      clearReleaseTimer()
      try {
        if (!isCollapsed(peek.frame)) ctx.layout.toggleSidebar()
      } catch {}
      if (MODE === 'overlay') {
        try {
          peek.col.style.setProperty('--dsh-peek-width', `${Math.round(peek.railWidth)}px`)
        } catch {}
      }
      const generation = state.generation
      state.releaseTimer = window.setTimeout(() => {
        state.releaseTimer = 0
        if (state.generation === generation) detach(peek)
      }, RELEASE_DELAY)
    }

    function scheduleClose(ctx) {
      if (state.closeTimer !== 0 || state.peek === null) return
      state.closeTimer = window.setTimeout(() => {
        state.closeTimer = 0
        close(ctx)
      }, CLOSE_DELAY)
    }

    /**
     * Collapse now, skipping the leave grace. `suppress` stops the next pointer
     * move inside the rail from re-opening what the user just dismissed.
     */
    function releaseNow(ctx, suppress = false) {
      clearOpenTimer()
      clearCloseTimer()
      if (suppress) state.suppressed = true
      if (state.peek !== null) close(ctx)
    }

    function inside(left, right, top, bottom, x, y) {
      return x >= left - 1 && x <= right + 1 && y >= top - 1 && y <= bottom + 1
    }

    function onPointerMove(ctx, event) {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
      const frame = frameOf()
      if (frame === null) return

      const peek = state.peek
      if (peek !== null) {
        let rect
        try {
          rect = peek.col.getBoundingClientRect()
        } catch {
          return
        }
        if (inside(rect.left, rect.right, rect.top, rect.bottom, event.clientX, event.clientY)) {
          clearCloseTimer()
        } else {
          clearOpenTimer()
          scheduleClose(ctx)
        }
        return
      }

      if (!isCollapsed(frame)) {
        clearOpenTimer()
        state.suppressed = false
        return
      }
      if (frame.hasAttribute('data-sidebar-drawer') || frame.hasAttribute('data-dragging')) {
        clearOpenTimer()
        return
      }
      const col = columnOf(frame)
      if (col === null) {
        clearOpenTimer()
        return
      }
      let rect
      try {
        rect = col.getBoundingClientRect()
      } catch {
        return
      }
      const rail = rect.width >= RAIL_MIN
      const edge = rail ? rect.right : HOT_EDGE
      if (!inside(0, edge, rect.top, rect.bottom, event.clientX, event.clientY)) {
        clearOpenTimer()
        if (state.suppressed) state.suppressed = false
        return
      }
      if (state.suppressed) return
      scheduleOpen(ctx)
    }

    function onPointerDown(ctx, event) {
      const peek = state.peek
      if (peek === null) return
      const target = event.target
      if (target instanceof Node && peek.col.contains(target)) return
      releaseNow(ctx, true)
    }

    function onToggleClick(ctx, event) {
      const target = event.target instanceof Element ? event.target.closest(TOGGLE_SELECTOR) : null
      if (target === null) return
      // A manual toggle wins until the pointer leaves the rail.
      state.suppressed = true
      clearOpenTimer()
      if (state.peek !== null) {
        // The host's own click flips the state; only undo the overlay, after
        // React committed the new collapsed attribute.
        clearCloseTimer()
        state.closeTimer = window.setTimeout(() => {
          state.closeTimer = 0
          close(ctx)
        }, 40)
        return
      }
    }

    function onKeyDown(ctx, event) {
      if (event.key !== 'Escape') return
      if (state.peek !== null) releaseNow(ctx, true)
    }

    /** The pointer left the window: no pointermove will arrive to collapse it. */
    function onPointerOut(ctx, event) {
      if (event.relatedTarget !== null) return
      releaseNow(ctx)
    }

    function teardown(ctx) {
      clearOpenTimer()
      clearCloseTimer()
      clearReleaseTimer()
      unobserveFrame()
      if (state.peek !== null) {
        const peek = state.peek
        state.peek = null
        try {
          if (!isCollapsed(peek.frame)) ctx.layout.toggleSidebar()
        } catch {}
        detach(peek)
      }
    }

    /**
     * Rest the sidebar as the icon rail, the way Edge's collapsed rail does.
     * Runs once per page load, after the frame first renders.
     */
    function collapseAtStart(ctx, disposed) {
      let attempts = 0
      let timer = 0
      const attempt = () => {
        timer = 0
        if (disposed()) return
        const frame = frameOf()
        if (frame === null) {
          attempts += 1
          if (attempts < 20) timer = window.setTimeout(attempt, 100)
          return
        }
        if (frame.hasAttribute('data-sidebar-drawer') || isCollapsed(frame)) return
        try {
          ctx.layout.toggleSidebar()
        } catch {}
      }
      // The first attempt is synchronous so the boot layout does not linger.
      attempt()
      return () => {
        if (timer !== 0) window.clearTimeout(timer)
        timer = 0
      }
    }

    return {
      inject: ['layout'],
      apply(ctx) {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        try {
          if (window.matchMedia('(hover: none)').matches) return
        } catch {}

        console.info('[sidebar-peek] active', { mode: MODE, startCollapsed: START_COLLAPSED })

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', '@local/dsh-sidebar-peek')
          style.textContent = STYLE
          document.head.append(style)
          return () => { style.remove() }
        })

        ctx.effect(() => {
          const move = event => onPointerMove(ctx, event)
          const down = event => onPointerDown(ctx, event)
          const click = event => onToggleClick(ctx, event)
          const key = event => onKeyDown(ctx, event)
          const out = event => onPointerOut(ctx, event)
          const blur = () => releaseNow(ctx)
          const resize = () => releaseNow(ctx)
          let disposed = false
          const stopStart = START_COLLAPSED ? collapseAtStart(ctx, () => disposed) : () => {}
          document.addEventListener('pointermove', move, { capture: true, passive: true })
          document.addEventListener('pointerdown', down, { capture: true, passive: true })
          document.addEventListener('pointerout', out, { capture: true, passive: true })
          document.addEventListener('click', click, true)
          document.addEventListener('keydown', key, true)
          window.addEventListener('blur', blur)
          window.addEventListener('resize', resize)
          return () => {
            disposed = true
            stopStart()
            document.removeEventListener('pointermove', move, { capture: true })
            document.removeEventListener('pointerdown', down, { capture: true })
            document.removeEventListener('pointerout', out, { capture: true })
            document.removeEventListener('click', click, true)
            document.removeEventListener('keydown', key, true)
            window.removeEventListener('blur', blur)
            window.removeEventListener('resize', resize)
            teardown(ctx)
          }
        })
      },
    }
  },
})
