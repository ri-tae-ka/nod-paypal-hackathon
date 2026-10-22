import {
  AllCommunityModule,
  type CellValueChangedEvent,
  type ColDef,
  type ICellRendererParams,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef } from "react";
import { formatCents } from "../lib/format";
import type { VersionItem } from "../types/api";
import styles from "./SheetGrid.module.css";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#2b5fb4",
  borderColor: "#e3e8f0",
  headerBackgroundColor: "#f3f8ff",
  headerTextColor: "#1d3f78",
  oddRowBackgroundColor: "#fffdf3",
  rowHoverColor: "#e6f0ff",
  selectedRowBackgroundColor: "#e6f0ff",
  fontFamily: "inherit",
  fontSize: 14,
  wrapperBorderRadius: 10,
});

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
  onRemove: (item: VersionItem) => void;
}

function ProductCell({ data }: ICellRendererParams<Row>) {
  if (!isItem(data)) return <strong>{data?.title}</strong>;
  return (
    <div className={styles.product}>
      {data.imageUrl ? <img src={data.imageUrl} alt="" className={styles.thumb} /> : <span className={styles.thumb} />}
      <div className={styles.productText}>
        <a href={data.buyUrl} target="_blank" rel="noreferrer" title={data.title}>
          {data.title}
        </a>
        <span className="muted">
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

interface Props {
  items: VersionItem[];
  totalCents: number;
  editable: boolean;
  onQuantityChange: (item: VersionItem, quantity: number) => void;
  onRemove: (item: VersionItem) => void;
}

export function SheetGrid({ items, totalCents, editable, onQuantityChange, onRemove }: Props) {
  const gridRef = useRef<AgGridReact<Row>>(null);
  // Column defs stay stable (rebuilding them reorders columns); editability is read through refs.
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const context = useMemo<Context>(
    () => ({ editableRef, onRemove: (item) => onRemoveRef.current(item) }),
    [],
  );

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
      <AgGridReact<Row>
        ref={gridRef}
        theme={theme}
        rowData={items}
        getRowId={({ data }) => data.id}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true }}
        pinnedBottomRowData={pinnedBottomRowData}
        context={context}
        onCellValueChanged={onCellValueChanged}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        domLayout="autoHeight"
        suppressNoRowsOverlay
        getRowClass={({ node }) => (node.rowPinned ? styles.totalRow : undefined)}
      />
    </div>
  );
}
