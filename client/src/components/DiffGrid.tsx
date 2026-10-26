import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { formatCents } from "../lib/format";
import { gridTheme } from "../lib/gridTheme";
import type { VersionDiff } from "../types/api";
import styles from "./DiffGrid.module.css";

type Kind = "Added" | "Removed" | "Changed" | "Total";

interface DiffRow {
  id: string;
  kind: Kind;
  title: string;
  retailerDomain: string;
  qtyBefore: number | null;
  qtyAfter: number | null;
  priceBefore: number | null;
  priceAfter: number | null;
  deltaCents: number;
}

export function diffRows(d: VersionDiff): DiffRow[] {
  return [
    ...d.added.map<DiffRow>((l) => ({
      id: `a-${l.channel3ProductId}`,
      kind: "Added",
      title: l.title,
      retailerDomain: l.retailerDomain,
      qtyBefore: null,
      qtyAfter: l.quantity,
      priceBefore: null,
      priceAfter: l.unitPriceCents,
      deltaCents: l.lineTotalCents,
    })),
    ...d.removed.map<DiffRow>((l) => ({
      id: `r-${l.channel3ProductId}`,
      kind: "Removed",
      title: l.title,
      retailerDomain: l.retailerDomain,
      qtyBefore: l.quantity,
      qtyAfter: null,
      priceBefore: l.unitPriceCents,
      priceAfter: null,
      deltaCents: -l.lineTotalCents,
    })),
    ...d.changed.map<DiffRow>((l) => ({
      id: `c-${l.channel3ProductId}`,
      kind: "Changed",
      title: l.title,
      retailerDomain: l.retailerDomain,
      qtyBefore: l.before.quantity,
      qtyAfter: l.quantity,
      priceBefore: l.before.unitPriceCents,
      priceAfter: l.unitPriceCents,
      deltaCents: l.lineTotalCents - l.before.lineTotalCents,
    })),
  ];
}

const num = ({ value }: { value: number | null }) => (value === null ? "–" : String(value));
const money = ({ value }: { value: number | null }) => (value === null ? "–" : formatCents(value));
const signed = ({ value }: { value: number | null }) =>
  value === null || value === 0 ? "–" : `${value > 0 ? "+" : "−"}${formatCents(Math.abs(value))}`;

export function DiffGrid({ diff }: { diff: VersionDiff }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  const { from, to } = diff;

  const columnDefs = useMemo<ColDef<DiffRow>[]>(
    () => [
      {
        field: "kind",
        headerName: "Change",
        width: 110,
        cellClass: ({ value }) => styles[(value as string).toLowerCase()] ?? "",
      },
      { field: "title", headerName: "Product", flex: 3, minWidth: 220, tooltipField: "title" },
      { field: "retailerDomain", headerName: "Retailer", flex: 1, minWidth: 120 },
      { field: "qtyBefore", headerName: `Qty v${from.number}`, width: 105, type: "rightAligned", valueFormatter: num },
      { field: "qtyAfter", headerName: `Qty v${to.number}`, width: 105, type: "rightAligned", valueFormatter: num },
      { field: "priceBefore", headerName: `Price v${from.number}`, width: 125, type: "rightAligned", valueFormatter: money },
      { field: "priceAfter", headerName: `Price v${to.number}`, width: 125, type: "rightAligned", valueFormatter: money },
      {
        field: "deltaCents",
        headerName: "Total impact",
        width: 130,
        type: "rightAligned",
        valueFormatter: signed,
        cellClass: ({ value }) => (value < 0 ? styles.cheaper : value > 0 ? styles.pricier : ""),
      },
    ],
    [from.number, to.number],
  );

  return (
    <div className={styles.wrapper}>
      <AgGridReact<DiffRow>
        theme={gridTheme}
        rowData={rows}
        getRowId={({ data }) => data.id}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true }}
        getRowClass={({ data }) => (data ? styles[`row${data.kind}`] : undefined)}
        pinnedBottomRowData={[
          {
            id: "net",
            kind: "Total",
            title: `Net change, v${from.number} → v${to.number}`,
            retailerDomain: "",
            qtyBefore: null,
            qtyAfter: null,
            priceBefore: from.totalCents,
            priceAfter: to.totalCents,
            deltaCents: diff.totalDeltaCents,
          },
        ]}
        domLayout="autoHeight"
        suppressNoRowsOverlay
      />
    </div>
  );
}
