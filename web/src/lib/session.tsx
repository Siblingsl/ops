import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { get, setCsrf } from './api'
import type { Account, Me, SystemInfo, Work } from './types'

export function useMe() {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await get<Me>('/auth/me')
      setCsrf(me.csrf_token)
      return me
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
  })
  return q
}

/** Viewer role is read-only (FR-M1-06 / D-038); writing is blocked server-side too. */
export function useCanWrite() {
  const { data: me } = useMe()
  return me?.role !== 'viewer'
}

export function useAccounts() {
  const { data: me } = useMe()
  return useQuery({
    queryKey: ['accounts', me?.user_id ?? me?.username ?? '', me?.workspace.id ?? ''],
    queryFn: () => get<Account[]>('/accounts'),
    staleTime: 30_000,
    enabled: !!me?.workspace.id,
  })
}

export function useSystemInfo() {
  return useQuery({ queryKey: ['system'], queryFn: () => get<SystemInfo>('/system/info'), staleTime: 300_000 })
}

const LEGACY_KEY = 'ops.currentAccount'

export function currentWorkQueryKey(workId: string, userId: string, workspaceId: string) {
  return ['work', workId, userId, workspaceId] as const
}

export function rememberAccount(id: string, _userId?: string, _workspaceId?: string) {
  localStorage.setItem(LEGACY_KEY, id)
}

export function forgetAccount(id: string, _userId?: string, _workspaceId?: string) {
  if (localStorage.getItem(LEGACY_KEY) === id) localStorage.removeItem(LEGACY_KEY)
}

export function rememberedAccount(_userId?: string, _workspaceId?: string) {
  return localStorage.getItem(LEGACY_KEY)
}

export function useCurrentAccountSelection() {
  const location = useLocation()
  const me = useMe()
  const accounts = useAccounts()
  const accountMatch = location.pathname.match(/^\/a\/([^/]+)/)
  const workMatch = location.pathname.match(/^\/works\/([^/]+)/)
  const work = useQuery<Work>({
    queryKey: currentWorkQueryKey(workMatch?.[1] ?? '', me.data?.user_id ?? me.data?.username ?? '', me.data?.workspace.id ?? ''),
    queryFn: () => get<Work>(`/works/${workMatch![1]}`),
    enabled: !!workMatch && !!me.data?.workspace.id,
    staleTime: 30_000,
  })
  const userId = me.data ? me.data.user_id ?? me.data.username : undefined
  const workspaceId = me.data?.workspace.id

  const routeId = workMatch ? work.data?.account_id : accountMatch?.[1]
  const preferredId = rememberedAccount()
  const selectedId = workMatch ? routeId : routeId ?? preferredId
  const account = accounts.data?.find((item) => item.id === selectedId)
    ?? (!routeId ? accounts.data?.find((item) => item.status === 'active') : undefined)

  useEffect(() => {
    if (!account) return
    rememberAccount(account.id, userId, workspaceId)
  }, [account?.id, userId, workspaceId])

  return {
    account,
    selectedId,
    userId,
    workspaceId,
    accounts: accounts.data,
    isLoading: me.isLoading || accounts.isLoading || (!!workMatch && work.isLoading),
    error: me.error ?? accounts.error ?? (workMatch ? work.error : null),
  }
}

/** Resolve the account from the current route, falling back to the last active Web account. */
export function useCurrentAccount(): Account | undefined {
  return useCurrentAccountSelection().account
}

export function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: unknown[][]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}
