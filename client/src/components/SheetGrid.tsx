import type { CellValueChangedEvent, ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "../lib/format";
import { gridTheme as theme } from "../lib/gridTheme";
import type { VersionItem } from "../types/api";
import styles from "./SheetGrid.module.css";

type Row = VersionItem | TotalRow;
interface TotalRow {
  id: "total";
  title: string;
  quantity: number;
  lineTotalCents: number;
}
const isItem = (row: Row | undefined): row is VersionItem => !!row && row.id !== "total";

interface Context {
  editableRef: { current: boolean };
  newIdsRef: { current: Set<string> };
  onRemove: (item: VersionItem) => void;
}

function ProductCell({ data, context }: ICellRendererParams<Row, unknown, Context>) {
  if (!isItem(data)) return <strong>{data?.title}</strong>;
  return (
    <div className={styles.product}>
      {data.imageUrl ? <img src={data.imageUrl} alt="" className={styles.thumb} /> : <span className={styles.thumb} />}
      <div className={styles.productText}>
        <a href={data.buyUrl} target="_blank" rel="noreferrer" title={data.title}>
          {data.title}
        </a>
        <span className="muted">
          {context.newIdsRef.current.has(data.channel3ProductId) && <span className={styles.newTag}>New</span>}
          {[data.brand, data.retailerDomain].filter(Boolean).join(" · ")}
          {data.availability === "OutOfStock" && <span className={styles.oos}> · Out of stock</span>}
        </span>
      </div>
    </div>
  );
}

function RemoveCell({ data, context }: ICellRendererParams<Row, unknown, Context>) {
  if (!isItem(data) || !context.editableRef.current) return null;
  return (
    <button
      className={styles.remove}
      onClick={() => context.onRemove(data)}
      title="Remove from sheet"
      aria-label={`Remove ${data.title}`}
    >
      ✕
    </button>
  );
}

interface Changes {
  added: string[];
  removed: number;
  changed: { id: string; columns: string[] }[];
}

function compare(prev: Map<string, VersionItem>, next: VersionItem[]): Changes {
  const nextIds = new Set(next.map((i) => i.channel3ProductId));
  const changes: Changes = { added: [], removed: [...prev.keys()].filter((id) => !nextIds.has(id)).length, changed: [] };
  for (const item of next) {
    const before = prev.get(item.channel3ProductId);
    if (!before) {
      changes.added.push(item.channel3ProductId);
      continue;
    }
    const columns: string[] = [];
    if (before.unitPriceCents !== item.unitPriceCents) columns.push("unitPrice");
    if (before.quantity !== item.quantity) columns.push("quantity");
    if (before.lineTotalCents !== item.lineTotalCents) columns.push("lineTotal");
    if ((before.rationale ?? "") !== (item.rationale ?? "")) columns.push("rationale");
    if (columns.length) changes.changed.push({ id: item.channel3ProductId, columns });
  }
  return changes;
}

function describe({ added, removed, changed }: Changes) {
  const cells = changed.reduce((n, c) => n + c.columns.length, 0);
  const parts = [
    added.length && `${added.length} new ${added.length === 1 ? "item" : "items"}`,
    removed && `${removed} removed`,
    cells && `${cells} ${cells === 1 ? "cell" : "cells"} changed`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

interface Props {
  items: VersionItem[];
  /** Items the user saw before this grid mounted (e.g. another version); changes against it are highlighted. */
  baseline?: VersionItem[] | null;
  totalCents: number;
  editable: boolean;
  onQuantityChange: (item: VersionItem, quantity: number) => void;
  onRemove: (item: VersionItem) => void;
}

export function SheetGrid({ items, totalCents, editable, baseline, onQuantityChange, onRemove }: Props) {
  const gridRef = useRef<AgGridReact<Row>>(null);
  // Column defs stay stable (rebuilding them reorders columns); editability is read through refs.
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const newIdsRef = useRef<Set<string>>(new Set());
  const context = useMemo<Context>(
    () => ({ editableRef, newIdsRef, onRemove: (item) => onRemoveRef.current(item) }),
    [],
  );

  const prevRef = useRef<Map<string, VersionItem> | null>(
    baseline ? new Map(baseline.map((i) => [i.channel3ProductId, i])) : null,
  );
  const pendingRef = useRef<Changes | null>(null);
  const [summary, setSummary] = useState<{ text: string; key: number } | null>(null);

  const runFlash = useCallback(() => {
    const api = gridRef.current?.api;
    const changes = pendingRef.current;
    if (!api || !changes) return;
    pendingRef.current = null;
    const flash = { flashDuration: 900, fadeDuration: 1600 };
    const addedNodes = changes.added.map((id) => api.getRowNode(id)).filter((n) => !!n);
    if (addedNodes.length) {
      api.redrawRows({ rowNodes: addedNodes });
      requestAnimationFrame(() => gridRef.current?.api?.flashCells({ rowNodes: addedNodes, ...flash }));
    }
    for (const c of changes.changed) {
      const node = api.getRowNode(c.id);
      if (node) api.flashCells({ rowNodes: [node], columns: c.columns, ...flash });
    }
    const total = api.getPinnedBottomRow(0);
    if (total) api.flashCells({ rowNodes: [total], columns: ["quantity", "lineTotal"], ...flash });
  }, []);

  // Diff each new set of items against the last one and light up what changed.
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = new Map(items.map((i) => [i.channel3ProductId, i]));
    if (!prev) return;
    const changes = compare(prev, items);
    const text = describe(changes);
    if (!text) return;

    newIdsRef.current = new Set(changes.added);
    pendingRef.current = changes;
    setSummary({ text, key: Date.now() });
    const timers = [
      window.setTimeout(runFlash, 60),
      window.setTimeout(() => {
        newIdsRef.current = new Set();
        gridRef.current?.api?.refreshCells({ force: true, columns: ["product"] });
        setSummary(null);
      }, 6000),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [items, runFlash]);

  useEffect(() => {
    gridRef.current?.api?.refreshCells({ force: true, columns: ["quantity", "remove"] });
  }, [editable]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      { colId: "product", headerName: "Product", field: "title", cellRenderer: ProductCell, flex: 3, minWidth: 240, autoHeight: true },
      {
        colId: "rating",
        headerName: "Rating",
        width: 100,
        valueGetter: ({ data }) => (isItem(data) && data.rating ? data.rating.value : null),
        valueFormatter: ({ data }) =>
          isItem(data) && data.rating ? `★ ${data.rating.value.toFixed(1)} (${data.rating.count})` : "",
      },
      {
        colId: "unitPrice",
        headerName: "Unit price",
        width: 110,
        type: "rightAligned",
        valueGetter: ({ data }) => (isItem(data) ? data.unitPriceCents : null),
        valueFormatter: ({ value }) => (typeof value === "number" ? formatCents(value) : ""),
      },
      {
        colId: "quantity",
        headerName: "Qty",
        field: "quantity",
        width: 80,
        type: "rightAligned",
        editable: ({ data }) => editableRef.current && isItem(data),
        cellEditor: "agNumberCellEditor",
        cellEditorParams: { min: 1, max: 1000, precision: 0 },
        cellClass: ({ data }) =>
          editableRef.current && isItem(data)
            ? ["ag-right-aligned-cell", styles.editable ?? ""]
            : "ag-right-aligned-cell",
        valueParser: ({ newValue, oldValue }) => {
          const n = Number(newValue);
          return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : oldValue;
        },
      },
      {
        colId: "lineTotal",
        headerName: "Line total",
        field: "lineTotalCents",
        width: 115,
        type: "rightAligned",
        valueFormatter: ({ value }) => (typeof value === "number" ? formatCents(value) : ""),
        cellClass: ["ag-right-aligned-cell", styles.money ?? ""],
      },
      {
        colId: "rationale",
        headerName: "Why this pick",
        flex: 2,
        minWidth: 180,
        wrapText: true,
        autoHeight: true,
        valueGetter: ({ data }) => (isItem(data) ? (data.rationale ?? "") : ""),
        cellClass: styles.rationale,
      },
      {
        colId: "remove",
        headerName: "",
        width: 56,
        cellRenderer: RemoveCell,
        cellClass: styles.removeCell,
        sortable: false,
        resizable: false,
      },
    ],
    [],
  );

  const pinnedBottomRowData = useMemo<TotalRow[]>(
    () => [
      {
        id: "total",
        title: "Total",
        quantity: items.reduce((sum, i) => sum + i.quantity, 0),
        lineTotalCents: totalCents,
      },
    ],
    [items, totalCents],
  );

  const onCellValueChanged = (event: CellValueChangedEvent<Row>) => {
    if (isItem(event.data) && event.newValue !== event.oldValue) onQuantityChange(event.data, event.newValue as number);
  };

  return (
    <div className={styles.wrapper}>
      {summary && (
        <div key={summary.key} className={styles.changeNote} role="status">
          <span className={styles.spark}>✦</span> Updated: {summary.text}
        </div>
      )}
      <AgGridReact<Row>
        ref={gridRef}
        theme={theme}
        rowData={items}
        getRowId={({ data }) => (isItem(data) ? data.channel3ProductId : data.id)}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true }}
        pinnedBottomRowData={pinnedBottomRowData}
        context={context}
        onCellValueChanged={onCellValueChanged}
        onFirstDataRendered={runFlash}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        domLayout="autoHeight"
        suppressNoRowsOverlay
        getRowClass={({ node, data }) =>
          node.rowPinned
            ? styles.totalRow
            : isItem(data) && newIdsRef.current.has(data.channel3ProductId)
              ? styles.rowEnter
              : undefined
        }
      />
    </div>
  );
}
