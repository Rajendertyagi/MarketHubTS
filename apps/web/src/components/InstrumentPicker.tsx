import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalInstrument } from "@markethub/contracts";
import {
  searchInstruments, formatInstrumentLabel,
  type CatalogSearchPage, type CatalogSearchQuery
} from "../lib/catalog";
import { createRetrySleep } from "../lib/retry-sleep";

export const PICKER_PAGE_LIMIT = 25;
export const PICKER_MAX_RESULTS = 100;
export const PICKER_DEBOUNCE_MS = 275;

export interface PickerState {
  text: string;
  results: CanonicalInstrument[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  activeIndex: number;
}

export function initialPickerState(): PickerState {
  return { text: "", results: [], nextCursor: null, loading: false, loadingMore: false, error: null, activeIndex: -1 };
}

export interface PickerActions {
  onText: (text: string) => void;
  onSelect: (instrument: CanonicalInstrument) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
}

export interface PickerControllerDeps {
  search: (query: CatalogSearchQuery) => Promise<CatalogSearchPage>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onState: (state: PickerState) => void;
  onChange?: (canonicalId: string) => void;
  debounceMs?: number;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

/** Pure key mapping — testable without DOM. */
export type KeyAction = "down" | "up" | "select" | "clear" | null;
export function keyToAction(key: string): KeyAction {
  if (key === "ArrowDown") return "down";
  if (key === "ArrowUp") return "up";
  if (key === "Enter") return "select";
  if (key === "Escape") return "clear";
  return null;
}

/** Framework-free controller: injectable search/sleep so behavior is testable without DOM. */
export function createPickerController(deps: PickerControllerDeps) {
  let generation = 0;
  let controller: AbortController | null = null;
  let disposed = false;
  let state = initialPickerState();
  let cached: { canonicalId: string; label: string } | null = null;

  const emit = (patch: Partial<PickerState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };
  const current = (gen: number) => !disposed && gen === generation;

  const run = async (text: string, cursor: string | undefined, append: boolean) => {
    const gen = ++generation;
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    emit({
      loading: !append,
      loadingMore: append,
      error: null,
      activeIndex: -1,
      ...(append ? {} : { results: [], nextCursor: null })
    });
    await deps.sleep(deps.debounceMs ?? PICKER_DEBOUNCE_MS, signal);
    if (!current(gen)) return;
    try {
      const page = await deps.search({
        text, limit: PICKER_PAGE_LIMIT, ...(cursor ? { cursor } : {}), signal
      });
      if (!current(gen)) return;
      const seen = new Set(append ? state.results.map((r) => r.canonicalId) : []);
      const merged = append
        ? [...state.results, ...page.instruments.filter((r) => !seen.has(r.canonicalId) && (seen.add(r.canonicalId), true))]
        : page.instruments;
      emit({
        results: merged,
        nextCursor: merged.length >= PICKER_MAX_RESULTS ? null : page.nextCursor,
        loading: false,
        loadingMore: false
      });
    } catch (error) {
      if (!current(gen)) return;
      if (isAbortError(error)) return;
      emit({ error: error instanceof Error ? error.message : String(error), loading: false, loadingMore: false });
    }
  };

  const select = (instrument: CanonicalInstrument): string => {
    cached = { canonicalId: instrument.canonicalId, label: formatInstrumentLabel(instrument) };
    deps.onChange?.(instrument.canonicalId);
    return instrument.canonicalId;
  };
  const moveActive = (delta: number) => {
    if (state.results.length === 0) return;
    const next = state.activeIndex + delta;
    emit({ activeIndex: Math.max(0, Math.min(state.results.length - 1, next)) });
  };
  const activeOption = () => (state.activeIndex >= 0 ? state.results[state.activeIndex] ?? null : null);
  const onText = (text: string) => {
    emit({ text });
    const trimmed = text.trim();
    if (!trimmed) {
      generation++;
      if (controller) controller.abort();
      emit({ results: [], nextCursor: null, loading: false, loadingMore: false, error: null, activeIndex: -1 });
      return;
    }
    void run(trimmed, undefined, false);
  };

  return {
    getState: () => state,
    getCached: () => cached,
    select,
    onText,
    onLoadMore: () => {
      if (state.loadingMore || !state.nextCursor || state.results.length >= PICKER_MAX_RESULTS) return;
      void run(state.text.trim(), state.nextCursor, true);
    },
    onRetry: () => {
      const trimmed = state.text.trim();
      if (trimmed) void run(trimmed, undefined, false);
    },
    moveActive,
    active: activeOption,
    /** Returns "select" when a selection was made so the container can restore focus. */
    onKey: (key: string): "select" | "handled" | null => {
      const action = keyToAction(key);
      if (action === "down") { moveActive(1); return "handled"; }
      if (action === "up") { moveActive(-1); return "handled"; }
      if (action === "select") {
        const option = activeOption();
        if (option) { select(option); return "select"; }
        return null;
      }
      if (action === "clear") { onText(""); return "handled"; }
      return null;
    },
    dispose: () => {
      disposed = true;
      generation++;
      if (controller) controller.abort();
    }
  };
}

export type PickerController = ReturnType<typeof createPickerController>;

export interface InstrumentPickerProps {
  value: string;
  onChange: (canonicalId: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/** Pure presentational view — renderable with renderToStaticMarkup in tests. */
export function InstrumentPickerView({
  state, value, cached, label, placeholder, disabled, actions, idPrefix = "m6e", inputRef
}: {
  state: PickerState; value: string; cached: { canonicalId: string; label: string } | null;
  label: string; placeholder: string | undefined; disabled: boolean | undefined; actions: PickerActions;
  idPrefix?: string; inputRef?: { current: HTMLInputElement | null };
}) {
  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";
  const selectedLabel = cached && cached.canonicalId === value ? cached.label : value || "None selected";
  const listId = `${idPrefix}-options`;
  const optionId = (index: number) => `${idPrefix}-option-${index}`;
  const activeId = state.activeIndex >= 0 ? optionId(state.activeIndex) : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-300">{label}</label>
      <div className="text-xs text-slate-200" data-testid="picker-value">{selectedLabel}</div>
      <input
        ref={inputRef as never}
        aria-label={`Search ${label}`}
        className={input}
        placeholder={placeholder ?? "Search instruments…"}
        value={state.text}
        disabled={disabled}
        onChange={(e) => actions.onText(e.target.value)}
        onKeyDown={actions.onKeyDown}
        role="combobox"
        aria-expanded={state.results.length > 0}
        aria-controls={listId}
        aria-activedescendant={activeId}
        autoComplete="off"
      />
      {state.loading && <p className="text-xs text-slate-400" role="status">Searching…</p>}
      {state.error && (
        <div className="flex items-center gap-2" role="alert">
          <span className="text-xs text-amber-300">{state.error}</span>
          <button type="button" className={button} onClick={actions.onRetry}>Retry</button>
        </div>
      )}
      {!state.loading && !state.error && state.text.trim() && state.results.length === 0 && (
        <p className="text-xs text-slate-400" role="status">No matching instruments in the catalog.</p>
      )}
      {state.results.length > 0 && (
        <ul id={listId} role="listbox" className="max-h-40 overflow-y-auto rounded-md border border-slate-800">
          {state.results.map((instrument, index) => (
            <li
              key={instrument.canonicalId}
              id={optionId(index)}
              role="option"
              aria-selected={instrument.canonicalId === value}
              className={`cursor-pointer px-2 py-1 text-xs ${index === state.activeIndex ? "bg-slate-800 text-slate-100" : "text-slate-300"}`}
              onClick={() => actions.onSelect(instrument)}
            >
              {formatInstrumentLabel(instrument)}
            </li>
          ))}
        </ul>
      )}
      {state.nextCursor && !state.loadingMore && state.results.length < PICKER_MAX_RESULTS && (
        <button type="button" className={button} onClick={actions.onLoadMore}>Load more</button>
      )}
      {state.loadingMore && <p className="text-xs text-slate-400" role="status">Loading more…</p>}
    </div>
  );
}

/** State-owning container wired to the real client and abort-safe sleep. */
export function InstrumentPicker({ value, onChange, label, placeholder, disabled }: InstrumentPickerProps) {
  const [state, setState] = useState<PickerState>(initialPickerState);
  const controllerRef = useRef<PickerController | null>(null);
  const cachedRef = useRef<{ canonicalId: string; label: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();
  const [, forceRender] = useState(0);
  // Keep the controller stable even if a consumer passes an inline callback.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const sleep = createRetrySleep();
    const controller = createPickerController({
      search: searchInstruments,
      sleep,
      onState: setState,
      onChange: (id) => onChangeRef.current(id)
    });
    controllerRef.current = controller;
    return () => { controller.dispose(); controllerRef.current = null; };
  }, []);

  const restoreFocus = () => {
    cachedRef.current = controllerRef.current?.getCached() ?? null;
    inputRef.current?.focus();
    forceRender((n) => n + 1);
  };

  const actions: PickerActions = {
    onText: (text) => controllerRef.current?.onText(text),
    onSelect: (instrument) => { controllerRef.current?.select(instrument); restoreFocus(); },
    onLoadMore: () => controllerRef.current?.onLoadMore(),
    onRetry: () => controllerRef.current?.onRetry(),
    onKeyDown: (event) => {
      const result = controllerRef.current?.onKey(event.key);
      if (result) { event.preventDefault(); if (result === "select") restoreFocus(); }
    }
  };

  return (
    <InstrumentPickerView
      state={state}
      value={value}
      cached={cachedRef.current}
      label={label}
      placeholder={placeholder}
      disabled={disabled}
      idPrefix={idPrefix}
      inputRef={inputRef}
      actions={actions}
    />
  );
}
