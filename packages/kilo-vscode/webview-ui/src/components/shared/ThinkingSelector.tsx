/**
 * ThinkingSelector component
 * Popover-based dropdown for choosing a thinking effort variant.
 * Only rendered when the selected model supports reasoning variants, or when
 * it carries the ultracode switch (which every model supports).
 *
 * ThinkingSelectorBase — reusable core that accepts variants/value/onSelect props.
 * ThinkingSelector     — thin wrapper wired to session context for chat usage.
 */

import { type Accessor, Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { PopupSelector } from "./PopupSelector"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Switch } from "@kilocode/kilo-ui/switch"
import { useSession } from "../../context/session"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { isEnterKeyCommitNotIme } from "../../utils/ime-enter"
import { createTypeahead, isTypeaheadChar } from "../../utils/typeahead"

// ---------------------------------------------------------------------------
// Reusable base component
// ---------------------------------------------------------------------------

export interface ThinkingSelectorBaseProps {
  /** Available variant names (e.g. ["low","medium","high"]) */
  variants: string[]
  /** Currently selected variant */
  value: string | undefined
  /** Called when the user picks a variant */
  onSelect: (value: string) => void
  /** Called when the user clears selection via default row. */
  onClear?: () => void
  /** Include default/unset row at top. */
  allowClear?: boolean
  /** Label for default/unset row. */
  clearLabel?: string
  /** Popover placement — defaults to top-start. */
  placement?: "top-start" | "bottom-start" | "bottom-end" | "top-end"
  /** Render inline instead of through a portal when nested in a dialog. */
  portal?: boolean
  /** Delay outside dismissal while the popover opens inside a dialog. */
  deferDismiss?: boolean
  /** Listen for the global prompt trigger event. Defaults to true. */
  globalTrigger?: boolean
  /** Only respond to picker events from this prompt scope. */
  trigger?: string
  /** Show the Shift+Tab cycle hint in the trigger tooltip. */
  cycleHint?: boolean
  /** Accessible name for the selector trigger. */
  label?: string
  /** Disable this prompt-scoped selector while a permission owns the prompt. */
  blocked?: boolean
  /** Short title shown above the options, so the list explains itself. */
  heading?: string
  /**
   * Ultracode switch shown under the options. When set, the popover opens even
   * for a model without variants, and the trigger reads "· Ultracode" while on.
   */
  ultracode?: { checked: boolean; onChange: (value: boolean) => void; label: string; description: string }
}

export const ThinkingSelectorBase: Component<ThinkingSelectorBaseProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [focused, setFocused] = createSignal(-1)
  const language = useLanguage()
  let listRef: HTMLDivElement | undefined

  const rows = () => {
    if (props.variants.length === 0 && !props.value) return []
    return props.allowClear ? [undefined, ...props.variants] : props.variants
  }
  const clearLabel = () => props.clearLabel ?? "Not set"
  const visible = () => rows().length > 0 || !!props.ultracode
  const checked = () => !!props.ultracode?.checked

  function display(value: string | undefined) {
    if (!value) return clearLabel()
    return value.charAt(0).toUpperCase() + value.slice(1)
  }

  function focusItem(idx: number) {
    const items = listRef?.querySelectorAll<HTMLElement>("[role=option]")
    if (!items) return
    const clamped = Math.max(0, Math.min(idx, items.length - 1))
    setFocused(clamped)
    items[clamped]?.focus()
  }

  const typeahead = createTypeahead(() => rows().map(display))

  function refocus() {
    requestAnimationFrame(() => {
      // Another picker took focus (for example the prompt pill switched to the
      // agent or model popover on hover). Do not pull focus back to the prompt.
      const el = document.activeElement
      if (el?.closest("[data-component='popover-content']") && !listRef?.contains(el)) return
      window.dispatchEvent(new CustomEvent("focusPrompt", { detail: { restore: true } }))
    })
  }

  function onOpen(val: boolean) {
    if (val) {
      if (props.blocked) return
      const items = rows()
      const idx = items.findIndex((v) => v === props.value)
      setFocused(idx >= 0 ? idx : 0)
      typeahead.reset()
      setOpen(true)
      return
    }
    setOpen(false)
    refocus()
  }

  const onTrigger = (event: Event) => {
    const source = (event as CustomEvent<{ source?: string }>).detail?.source
    if (source !== props.trigger || props.blocked) return
    if (!visible()) return
    onOpen(true)
  }
  createEffect(() => {
    if (props.blocked) {
      setOpen(false)
      return
    }
    if (!(props.globalTrigger ?? true)) return
    window.addEventListener("openVariantPicker", onTrigger)
    onCleanup(() => window.removeEventListener("openVariantPicker", onTrigger))
  })

  function pick(value: string | undefined) {
    if (value === undefined) {
      props.onClear?.()
      onOpen(false)
      return
    }
    props.onSelect(value)
    onOpen(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    const items = rows()
    const len = items.length
    const cur = focused()
    if (len === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      focusItem((cur + 1) % len)
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      focusItem((cur - 1 + len) % len)
      return
    }
    if (e.key === "Home") {
      e.preventDefault()
      focusItem(0)
      return
    }
    if (e.key === "End") {
      e.preventDefault()
      focusItem(len - 1)
      return
    }
    if (e.key === " " && typeahead.active()) {
      e.preventDefault()
      const idx = typeahead.type(e.key)
      if (idx >= 0) focusItem(idx)
      return
    }
    if (e.key === " " || isEnterKeyCommitNotIme(e)) {
      e.preventDefault()
      if (cur >= 0 && cur < len) pick(items[cur])
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onOpen(false)
      return
    }
    if (isTypeaheadChar(e)) {
      const idx = typeahead.type(e.key)
      if (idx >= 0) {
        e.preventDefault()
        focusItem(idx)
      }
    }
  }

  const tooltip = () => {
    const suffix = checked() ? ` · ${props.ultracode?.label}` : ""
    if (rows().length === 0) return props.ultracode?.label ?? ""
    return `${language.t("prompt.thinking.tooltip")}: ${display(props.value)}${suffix}`
  }

  return (
    <Show when={visible()}>
      <Tooltip
        value={
          <div data-slot="tooltip-keybind">
            <span>{tooltip()}</span>
            <Show when={props.cycleHint && rows().length > 0}>
              <span data-slot="tooltip-keybind-key">Shift+Tab</span>
            </Show>
          </div>
        }
        placement="top"
        openDelay={0}
      >
        <PopupSelector
          expanded={false}
          placement={props.placement ?? "top-start"}
          preferredWidth={props.ultracode ? 240 : 180}
          minHeight={100}
          portal={props.portal}
          deferDismiss={props.deferDismiss}
          open={open()}
          onOpenChange={onOpen}
          triggerAs={Button}
          triggerProps={{ variant: "ghost", size: "small", "aria-label": props.label, disabled: props.blocked }}
          trigger={
            <>
              {/* Keyed so the label remounts on change and the prompt pill can animate it. */}
              <Show when={display(props.value)} keyed>
                {(label) => (
                  <span class="thinking-selector-trigger-label" data-unset={props.value ? undefined : ""}>
                    {label}
                    {/* Inside the label, so it collapses with it and PromptSelectors measures both together. */}
                    <Show when={checked()}>
                      <span aria-hidden="true">{" ·"}</span>
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={checked()}>
                <span class="thinking-selector-trigger-suffix">{props.ultracode?.label}</span>
              </Show>
              <svg
                class="selector-trigger-chevron"
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{ "flex-shrink": "0" }}
              >
                <path d="M8 4l4 5H4l4-5z" />
              </svg>
            </>
          }
        >
          {(bodyH) => (
            <>
              <Show when={rows().length > 0}>
                <div
                  class="thinking-selector-list"
                  role="listbox"
                  aria-label={props.heading}
                  ref={listRef}
                  onKeyDown={onKeyDown}
                  style={bodyH() !== undefined ? { "max-height": `${bodyH()}px` } : {}}
                >
                  <Show when={props.heading}>
                    <div class="thinking-selector-heading" aria-hidden="true">
                      {props.heading}
                    </div>
                  </Show>
                  <For each={rows()}>
                    {(v, i) => (
                      <div
                        class={`thinking-selector-item${props.value === v ? " selected" : ""}`}
                        role="option"
                        aria-selected={props.value === v}
                        tabindex={focused() === i() ? 0 : -1}
                        data-autofocus={focused() === i() ? "" : undefined}
                        onClick={() => pick(v)}
                        onFocus={() => setFocused(i())}
                      >
                        <span class="thinking-selector-item-name">{display(v)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              {/* Outside the listbox: its key handler and pick() would treat the switch as an option and close. */}
              <Show when={props.ultracode}>
                {(ultra) => (
                  <div class="thinking-selector-ultracode" data-divided={rows().length > 0 ? "" : undefined}>
                    <Switch
                      checked={ultra().checked}
                      onChange={(value) => ultra().onChange(value)}
                      description={ultra().description}
                    >
                      {ultra().label}
                    </Switch>
                  </div>
                )}
              </Show>
            </>
          )}
        </PopupSelector>
      </Tooltip>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Chat-specific wrapper (backwards-compatible)
// ---------------------------------------------------------------------------

interface ThinkingSelectorProps {
  sessionID?: Accessor<string | undefined>
  blocked?: boolean
}

export const ThinkingSelector: Component<ThinkingSelectorProps> = (props) => {
  const session = useSession()
  const { settings, features } = useConfig()
  const language = useLanguage()
  const id = () => props.sessionID?.()
  const ultracode = () =>
    features().workflows
      ? {
          checked: session.ultracode.current(id()),
          onChange: (value: boolean) => session.ultracode.select(value, id()),
          label: language.t("prompt.ultracode.label"),
          description: language.t("prompt.ultracode.description"),
        }
      : undefined

  return (
    <ThinkingSelectorBase
      variants={session.variantList(id())}
      value={session.currentVariant(id())}
      blocked={props.blocked}
      onSelect={(value) => session.selectVariant(value, id())}
      onClear={() => session.selectVariant(undefined, id())}
      allowClear
      clearLabel={language.t("common.default")}
      heading={language.t("prompt.thinking.tooltip")}
      cycleHint={settings()["chat.shiftTabCyclesVariant"] !== false}
      ultracode={ultracode()}
    />
  )
}
