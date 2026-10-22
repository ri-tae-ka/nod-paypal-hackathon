import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, login, logout, register } from "../api/auth";

const ME = ["me"] as const;

export function useMe() {
  return useQuery({ queryKey: ME, queryFn: fetchMe, staleTime: Infinity });
}

export function useAuthActions() {
  const queryClient = useQueryClient();
  const onSignedIn = (user: Awaited<ReturnType<typeof login>>) => {
    queryClient.clear();
    queryClient.setQueryData(ME, user);
  };
  return {
    login: useMutation({ mutationFn: login, onSuccess: onSignedIn }),
    register: useMutation({ mutationFn: register, onSuccess: onSignedIn }),
    logout: useMutation({
      mutationFn: logout,
      onSettled: () => {
        queryClient.clear();
        queryClient.setQueryData(ME, null);
      },
    }),
  };
}
