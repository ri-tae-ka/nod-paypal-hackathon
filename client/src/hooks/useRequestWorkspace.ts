import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/http";
import * as requestsApi from "../api/requests";
import type { RequestDetail, Version } from "../types/api";

const CONFLICT_CODES = new Set(["stale_revision", "version_conflict", "version_locked", "request_locked"]);

/** Loads one request with its latest version and exposes sheet-editing mutations. */
export function useRequestWorkspace(id: string) {
  const queryClient = useQueryClient();
  const key = ["request", id];
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery({ queryKey: key, queryFn: () => requestsApi.getRequest(id) });

  const applyVersion = (version: Version) => {
    queryClient.setQueryData<RequestDetail>(key, (old) =>
      old
        ? {
            request: { ...old.request, latestVersion: Math.max(old.request.latestVersion, version.number) },
            latestVersion: version,
          }
        : old,
    );
    void queryClient.invalidateQueries({ queryKey: ["requests"] });
    void queryClient.invalidateQueries({ queryKey: [...key, "versions"] });
    void queryClient.invalidateQueries({ queryKey: [...key, "diff"] });
  };

  const onError = (error: Error) => {
    if (error instanceof ApiError && CONFLICT_CODES.has(error.code)) {
      setNotice(`${error.message} The sheet has been refreshed.`);
    } else {
      setNotice(error.message);
    }
    // Always resync so the grid never shows a value the server rejected
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const options = {
    onMutate: () => setNotice(null),
    onSuccess: applyVersion,
    onError,
  };

  const updateQuantity = useMutation({
    mutationFn: (v: { n: number; itemId: string; quantity: number; revision: number }) =>
      requestsApi.updateItemQuantity(id, v.n, v.itemId, v.quantity, v.revision),
    ...options,
  });

  const removeItem = useMutation({
    mutationFn: (v: { n: number; itemId: string; revision: number }) =>
      requestsApi.removeItem(id, v.n, v.itemId, v.revision),
    ...options,
  });

  const addProduct = useMutation({
    mutationFn: async (v: { channel3ProductId: string; quantity: number; version: Version | null }) =>
      v.version
        ? requestsApi.addItem(id, v.version.number, {
            channel3ProductId: v.channel3ProductId,
            quantity: v.quantity,
            expectedRevision: v.version.revision,
          })
        : requestsApi.createVersion(id, {
            items: [{ channel3ProductId: v.channel3ProductId, quantity: v.quantity }],
            summary: "Started manually",
          }),
    ...options,
  });

  const copyVersion = useMutation({
    mutationFn: (v: { n: number; summary?: string; expectedLatestVersion: number }) =>
      requestsApi.copyVersion(id, v.n, { summary: v.summary, expectedLatestVersion: v.expectedLatestVersion }),
    ...options,
  });

  // Errors stay on the mutation so the agent panel can explain them in place
  const generate = useMutation({
    mutationFn: (v: { instruction?: string; expectedLatestVersion: number }) => requestsApi.generateVersion(id, v),
    onMutate: () => setNotice(null),
    onSuccess: (result) => {
      applyVersion(result.version);
      if (result.diff) {
        queryClient.setQueryData([...key, "diff", result.diff.to.number, result.diff.from.number], result.diff);
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && CONFLICT_CODES.has(error.code)) void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return {
    query,
    generate,
    copyVersion,
    notice,
    clearNotice: () => setNotice(null),
    updateQuantity,
    removeItem,
    addProduct,
    busy: updateQuantity.isPending || removeItem.isPending || addProduct.isPending || copyVersion.isPending || generate.isPending,
  };
}
