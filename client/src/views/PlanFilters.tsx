import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { money0 } from "@/lib/model";
import { C, linkBtn, pill, primaryBtn, textInput, num } from "@/lib/ui";
import {
  CATEGORY_LABELS,
  EMPTY_FILTERS,
  LIST_KEYS,
  SORT_CHOICES,
  billError,
  billSet,
  categoryCount,
  filterCount,
  parseDollars,
  parseSortValue,
  sortLabel,
  sortValue,
  toggleIn,
  withBill,
  type BillRange,
  type FilterKey,
  type ListKey,
  type PlanFilters,
  type SortState,
} from "@/lib/planfilters";

/**
 * The Medical Plans filter controls: a button per category that opens a
 * panel beneath it on a desktop, one Filters button that opens a drawer on
 * a phone, a Sort by control apart from both, and the row of chips that
 * shows what is applied. The rules they apply live in lib/planfilters.ts;
 * this file is only how they look and how they are reached — by pointer,
 * by keyboard, and by a screen reader.
 */

/** One choice in a checkbox list, with how many plans choosing it would show. */
export interface FilterOption {
  value: string;
  label: string;
  count: number;
}
export type FilterOptionLists = Record<ListKey, FilterOption[]>;

/** The lowest and highest Total Monthly Bill among the group's plans: the hint under the range fields. */
export type BillBounds = { min: number; max: number } | null;

/** Where the Filters drawer and the dropdown panels sit above the page. */
const LAYER = 40;

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transition: "transform 0.12s ease", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/**
 * A toolbar button: tinted while its category has selections (the count in
 * brackets), only a shade darker while its panel is open, so opening one
 * never reads as filtering.
 */
function toolbarButton(active: boolean, open: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 10px 7px 13px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 4,
    cursor: "pointer",
    whiteSpace: "nowrap",
    color: active ? C.blue : C.ink,
    background: active ? C.blueTint : open ? C.hairline : C.card,
    border: `1px solid ${active ? C.blue : open ? C.inputEdge : C.border}`,
  };
}

const panelStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  zIndex: LAYER,
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(11,33,56,0.18)",
  padding: "10px 12px 12px",
  maxWidth: "calc(100vw - 32px)",
  textAlign: "left",
};

/** The first thing in a panel a keyboard user would want: a checkbox, a field, a button. */
const focusFirst = (root: HTMLElement | null | undefined) => root?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();

/**
 * A filter button with its panel anchored beneath it. The parent keeps one
 * open at a time; this closes itself on Escape (focus back on the button),
 * on a click anywhere else, and when Tab leaves it.
 */
export function FilterDropdown({ id, label, count, open, onToggle, onClose, width = 250, children }: { id: string; label: string; count: number; open: boolean; onToggle: () => void; onClose: () => void; width?: number; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Hang the panel off the button's right edge when it would otherwise run off the page.
    const r = button.current?.getBoundingClientRect();
    setAlignRight(!!r && r.left + width > window.innerWidth - 16);
    focusFirst(root.current?.querySelector<HTMLElement>("[data-panel]"));
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      button.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, width]);
  const panelId = `${id}-panel`;
  return (
    <div
      ref={root}
      style={{ position: "relative", display: "inline-block" }}
      onBlur={(e) => {
        // Tabbing out closes the panel; a click on the panel's own blank space does not.
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      <button ref={button} id={id} type="button" onClick={onToggle} aria-expanded={open} aria-controls={open ? panelId : undefined} style={toolbarButton(count > 0, open)}>
        <span>
          {label}
          {count > 0 && <span> ({count})</span>}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div id={panelId} data-panel role="group" aria-labelledby={id} style={{ ...panelStyle, width, left: alignRight ? "auto" : 0, right: alignRight ? 0 : "auto" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A list of checkboxes: any number may be on. A choice no plan would match
 * is greyed and disabled — unless it is already on, so it can still be
 * turned off.
 */
export function CheckList({ legend, options, selected, onToggle, hideLegend }: { legend: string; options: FilterOption[]; selected: string[]; onToggle: (value: string) => void; hideLegend?: boolean }) {
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
      <legend style={hideLegend ? srOnly : { fontSize: 12.5, fontWeight: 700, color: C.navy, padding: 0, marginBottom: 4 }}>{legend}</legend>
      {!options.length && <div style={{ fontSize: 13, color: C.faint, padding: "6px 4px" }}>Nothing to choose from.</div>}
      {options.map((o) => {
        const on = selected.includes(o.value);
        const off = !on && o.count === 0;
        return (
          <label key={o.value} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 4px", fontSize: 13.5, color: off ? C.ghost : C.ink, cursor: off ? "default" : "pointer", textTransform: "none" }}>
            <input type="checkbox" checked={on} disabled={off} onChange={() => onToggle(o.value)} style={{ margin: 0, width: 16, height: 16, accentColor: C.blue, cursor: off ? "default" : "pointer", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>{o.label}</span>
            <span style={{ fontSize: 12, color: off ? C.ghost : C.faint, ...num }}>
              {o.count}
              <span style={srOnly}> plan{o.count === 1 ? "" : "s"}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Minimum and maximum Total Monthly Bill. Given `onApply`, the pair waits
 * for its Apply button (or Enter); given `onChange` instead, every keystroke
 * goes straight out — the Filters drawer applies everything at once. Either
 * way a minimum above the maximum is called out and cannot be applied.
 */
export function BillFields({ value, bounds, onApply, onChange }: { value: BillRange; bounds: BillBounds; onApply?: (b: BillRange) => void; onChange?: (b: BillRange) => void }) {
  const [minText, setMinText] = useState(value.min == null ? "" : String(value.min));
  const [maxText, setMaxText] = useState(value.max == null ? "" : String(value.max));
  useEffect(() => {
    setMinText(value.min == null ? "" : String(value.min));
    setMaxText(value.max == null ? "" : String(value.max));
  }, [value.min, value.max]);
  const draft: BillRange = { min: parseDollars(minText), max: parseDollars(maxText) };
  const error = billError(draft);
  const dirty = draft.min !== value.min || draft.max !== value.max;
  const canApply = !error && dirty;
  const errorId = useId();
  const apply = () => {
    if (onApply && canApply) onApply(draft);
  };
  const edit = (which: "min" | "max", text: string) => {
    const t = text.replace(/[^\d,]/g, "");
    if (which === "min") setMinText(t);
    else setMaxText(t);
    const next = { ...draft, [which]: parseDollars(t) };
    onChange?.(next);
  };
  const field = (which: "min" | "max", label: string, text: string, placeholder: number | null) => (
    <label style={{ display: "block", flex: "1 1 110px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 3 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: C.faint, pointerEvents: "none" }}>$</span>
        <input
          value={text}
          inputMode="numeric"
          placeholder={placeholder == null ? "" : Math.round(placeholder).toLocaleString("en-US")}
          aria-label={`${label} total monthly bill, dollars`}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => edit(which, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          style={{ ...textInput, width: "100%", padding: "7px 8px 7px 20px", fontSize: 13.5, border: `1px solid ${error ? C.red : C.inputEdge}`, ...num }}
        />
      </div>
    </label>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        {field("min", "Minimum", minText, bounds?.min ?? null)}
        {field("max", "Maximum", maxText, bounds?.max ?? null)}
      </div>
      {error ? (
        <div id={errorId} role="alert" style={{ fontSize: 12, color: C.red, marginTop: 6 }}>
          {error}
        </div>
      ) : (
        bounds && (
          <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>
            Plans run {money0(bounds.min)} – {money0(bounds.max)} a month.
          </div>
        )
      )}
      {onApply && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <button type="button" onClick={apply} disabled={!canApply} style={{ ...primaryBtn, padding: "7px 16px", fontSize: 13, fontWeight: 600, ...(canApply ? {} : { background: C.ghost, border: `1px solid ${C.ghost}`, cursor: "default" }) }}>
            Apply
          </button>
          {billSet(value) && (
            <button type="button" onClick={() => onApply({ min: null, max: null })} style={{ ...linkBtn, fontSize: 13 }}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const sortSelect: CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  padding: "7px 26px 7px 10px",
  fontSize: 13,
  fontWeight: 600,
  color: C.ink,
  background: `${C.card} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23333' stroke-width='2'/%3E%3C/svg%3E") no-repeat right 9px center`,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  cursor: "pointer",
  outline: "none",
};

/**
 * Sort by, apart from the filters. The six choices are the dollar columns
 * both ways; a column sorted from the table header outside them (Carrier,
 * Plan) still shows here as the current order, so the two never disagree.
 */
export function SortSelect({ sort, onChange }: { sort: SortState; onChange: (s: SortState) => void }) {
  const listed = SORT_CHOICES.some((c) => c.key === sort.key && c.dir === sort.dir);
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted, whiteSpace: "nowrap" }}>
      Sort by
      <select
        value={sortValue(sort)}
        onChange={(e) => {
          const s = parseSortValue(e.target.value);
          if (s) onChange(s);
        }}
        style={sortSelect}
      >
        {!listed && <option value={sortValue(sort)}>{sortLabel(sort)}</option>}
        {SORT_CHOICES.map((c) => (
          <option key={sortValue(c)} value={sortValue(c)}>
            {sortLabel(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface AppliedChip {
  key: string;
  label: string;
  onRemove: () => void;
}

/**
 * Under the toolbar: how many plans are showing, a removable chip for every
 * applied selection, and Clear all. The count is announced as it changes.
 */
/** "Showing all 152 plans" / "Showing 12 of 152 plans". */
export const showingText = (showing: number, total: number) => (showing === total ? `Showing all ${total} plan${total === 1 ? "" : "s"}` : `Showing ${showing} of ${total} plans`);

export function AppliedFilters({ showing, total, chips, onClearAll, showCount = true }: { showing: number; total: number; chips: AppliedChip[]; onClearAll: () => void; showCount?: boolean }) {
  return (
    <div role="region" aria-label="Applied filters" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 10 }}>
      {showCount && (
        <span aria-live="polite" style={{ fontSize: 13, color: C.body, marginRight: 4, ...num }}>
          {showingText(showing, total)}
        </span>
      )}
      {chips.map((c) => (
        <button key={c.key} type="button" onClick={c.onRemove} aria-label={`Remove filter: ${c.label}`} style={{ ...pill(C.blueInk, C.blueTint, C.blueEdge), display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "4px 8px 4px 10px", cursor: "pointer", textTransform: "none" }}>
          {c.label}
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1, opacity: 0.8 }}>
            ×
          </span>
        </button>
      ))}
      {chips.length > 0 && (
        <button type="button" onClick={onClearAll} style={{ ...linkBtn, fontSize: 13, fontWeight: 600, marginLeft: 4 }}>
          Clear all
        </button>
      )}
    </div>
  );
}

/**
 * The desktop toolbar's six dropdowns. Checkbox changes apply at once; the
 * bill range applies on its Apply button.
 */
export function FilterDropdowns({ filters, onChange, options, bounds, open, setOpen }: { filters: PlanFilters; onChange: (f: PlanFilters) => void; options: FilterOptionLists; bounds: BillBounds; open: FilterKey | null; setOpen: (k: FilterKey | null) => void }) {
  const base = useId();
  const close = () => setOpen(null);
  return (
    <>
      {LIST_KEYS.map((k) => (
        <FilterDropdown key={k} id={`${base}-${k}`} label={CATEGORY_LABELS[k]} count={categoryCount(filters, k)} open={open === k} onToggle={() => setOpen(open === k ? null : k)} onClose={close}>
          <CheckList legend={CATEGORY_LABELS[k]} options={options[k]} selected={filters[k]} onToggle={(v) => onChange(toggleIn(filters, k, v))} />
        </FilterDropdown>
      ))}
      <FilterDropdown id={`${base}-bill`} label={CATEGORY_LABELS.bill} count={categoryCount(filters, "bill")} open={open === "bill"} onToggle={() => setOpen(open === "bill" ? null : "bill")} onClose={close} width={300}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Total Monthly Bill</div>
        <BillFields
          value={filters.bill}
          bounds={bounds}
          onApply={(b) => {
            onChange(withBill(filters, b));
            close();
          }}
        />
      </FilterDropdown>
    </>
  );
}

/**
 * On a phone: one Filters button opens a drawer with every category. Choices
 * are pending until "Show N plans"; closing any other way keeps what was
 * applied before. Focus stays inside while it is open and returns to the
 * button after.
 */
export function FilterDrawer({ open, onClose, applied, onApply, optionsFor, resultCountFor, bounds, returnTo }: { open: boolean; onClose: () => void; applied: PlanFilters; onApply: (f: PlanFilters) => void; optionsFor: (f: PlanFilters) => FilterOptionLists; resultCountFor: (f: PlanFilters) => number; bounds: BillBounds; returnTo: RefObject<HTMLButtonElement> }) {
  const [pending, setPending] = useState<PlanFilters>(applied);
  const dialog = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    setPending(applied);
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog.current) return;
      // Tab wraps within the drawer; nothing behind it is reachable while it is open.
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled]), select, [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const target = returnTo.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      target?.focus();
    };
    // Pending resets to what is applied each time the drawer opens, not as it is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const options = optionsFor(pending);
  const n = resultCountFor(pending);
  const error = billError(pending.bill);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: LAYER + 10, background: "rgba(20,24,28,0.45)", display: "flex", justifyContent: "flex-end" }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} style={{ width: "min(420px, 100%)", height: "100%", background: C.card, display: "flex", flexDirection: "column", boxShadow: "-8px 0 32px rgba(11,33,56,0.22)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${C.hairline}` }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.navy }}>
            Filters
          </h2>
          <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close filters without applying" style={{ background: "none", border: "none", fontSize: 24, lineHeight: 1, color: C.muted, cursor: "pointer", padding: "2px 6px" }}>
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 16px 16px" }}>
          {LIST_KEYS.map((k) => (
            <div key={k} style={{ padding: "12px 0", borderBottom: `1px solid ${C.hairline}` }}>
              <CheckList legend={CATEGORY_LABELS[k]} options={options[k]} selected={pending[k]} onToggle={(v) => setPending((p) => toggleIn(p, k, v))} />
            </div>
          ))}
          <div style={{ padding: "12px 0" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Total Monthly Bill</div>
            <BillFields value={pending.bill} bounds={bounds} onChange={(b) => setPending((p) => withBill(p, b))} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 16px", borderTop: `1px solid ${C.hairline}`, background: C.zebra }}>
          <button type="button" onClick={() => setPending(EMPTY_FILTERS)} disabled={filterCount(pending) === 0} style={{ ...linkBtn, fontSize: 13.5, fontWeight: 600, color: filterCount(pending) ? C.blue : C.ghost }}>
            Clear all
          </button>
          <button
            type="button"
            disabled={!!error}
            onClick={() => {
              if (error) return;
              onApply(pending);
              onClose();
            }}
            style={{ ...primaryBtn, padding: "10px 22px", fontSize: 14, fontWeight: 600, ...(error ? { background: C.ghost, border: `1px solid ${C.ghost}`, cursor: "default" } : {}) }}
          >
            Show {n} plan{n === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The button that opens the drawer, styled as the toolbar's other buttons. */
export function FiltersButton({ count, open, onClick, buttonRef }: { count: number; open: boolean; onClick: () => void; buttonRef: RefObject<HTMLButtonElement> }) {
  return (
    <button ref={buttonRef} type="button" onClick={onClick} aria-haspopup="dialog" aria-expanded={open} style={toolbarButton(count > 0, open)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 5h18l-7 8v6l-4 2v-8z" />
      </svg>
      <span>
        Filters
        {count > 0 && <span> ({count})</span>}
      </span>
      <Chevron open={open} />
    </button>
  );
}

/** Kept in the accessibility tree, out of sight. */
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };
