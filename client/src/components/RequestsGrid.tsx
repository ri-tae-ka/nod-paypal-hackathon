import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { formatCents, formatDate } from "../lib/format";
import { gridTheme } from "../lib/gridTheme";
import type { ProcurementRequest } from "../types/api";
import { StatusBadge } from "./StatusBadge";
import styles from "./RequestsGrid.module.css";

const isGroup = (r: ProcurementRequest) => r.memberCount > 1;
const POOL_LABEL = { open: "Pool · live", closing: "Pool · live", funded: "Pool · funded" } as const;
const poolLabel = (r: ProcurementRequest) =>
  r.poolStatus && r.poolStatus in POOL_LABEL ? POOL_LABEL[r.poolStatus as keyof typeof POOL_LABEL] : null;

function StatusCell({ data }: ICellRendererParams<ProcurementRequest>) {
  return data ? (
    <span className={styles.status}>
      <StatusBadge status={data.status} />
    </span>
  ) : null;
}

export function RequestsGrid({ requests }: { requests: ProcurementRequest[] }) {
  const navigate = useNavigate();

  const columnDefs = useMemo<ColDef<ProcurementRequest>[]>(
    () => [
      { field: "prompt", headerName: "Request", flex: 4, minWidth: 260, wrapText: true, autoHeight: true, cellClass: styles.prompt },
      {
        colId: "type",
        headerName: "Type",
        width: 130,
        filter: true,
        valueGetter: ({ data }) =>
          data ? (poolLabel(data) ?? (isGroup(data) ? `Group · ${data.memberCount}` : "Solo")) : "",
        cellClass: ({ data }) => (data && poolLabel(data) ? styles.pool : data && isGroup(data) ? styles.group : ""),
      },
      { field: "status", headerName: "Status", width: 150, filter: true, cellRenderer: StatusCell },
      {
        colId: "version",
        headerName: "Version",
        width: 110,
        valueGetter: ({ data }) => data?.latestVersion ?? 0,
        valueFormatter: ({ value }) => (value ? `v${value}` : "No sheet"),
      },
      {
        field: "budgetCents",
        headerName: "Budget",
        width: 120,
        type: "rightAligned",
        valueFormatter: ({ value }) => (typeof value === "number" ? formatCents(value) : "–"),
      },
      {
        colId: "role",
        headerName: "Role",
        width: 100,
        valueGetter: ({ data }) => (data?.role === "member" ? "Invited" : "Owner"),
      },
      {
        field: "createdAt",
        headerName: "Created",
        flex: 1,
        minWidth: 170,
        sort: "desc",
        valueFormatter: ({ value }) => (value ? formatDate(value as string) : ""),
      },
    ],
    [],
  );

  return (
    <div className={styles.wrapper}>
      <AgGridReact<ProcurementRequest>
        theme={gridTheme}
        rowData={requests}
        getRowId={({ data }) => data.id}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true }}
        onRowClicked={({ data }) => data && navigate(`/requests/${data.id}`)}
        rowClass={styles.row}
        domLayout="autoHeight"
        pagination={requests.length > 20}
        paginationPageSize={20}
      />
    </div>
  );
}
