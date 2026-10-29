import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { get, setCsrf } from './api'
import { isElectronDesktop } from './desktop-presentation.js'
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
const ACCOUNT_CHANGED = 'ops:current-account-changed'

export function currentWorkQueryKey(workId: string, userId: string, workspaceId: string) {
  return ['work', workId, userId, workspaceId] as const
}

export function currentAccountPreferenceKey(userId: string, workspaceId: string) {
  return `ops.currentAccount.v2:${userId}:${workspaceId}`
}

export function rememberAccount(id: string, userId?: string, workspaceId?: string) {
  if (isElectronDesktop(navigator.userAgent)) {
    if (userId && workspaceId) {
      localStorage.setItem(currentAccountPreferenceKey(userId, workspaceId), id)
      window.dispatchEvent(new Event(ACCOUNT_CHANGED))
    }
    return
  }
  localStorage.setItem(LEGACY_KEY, id)
}

export function forgetAccount(id: string, userId?: string, workspaceId?: string) {
  if (isElectronDesktop(navigator.userAgent)) {
    if (userId && workspaceId) {
      const key = currentAccountPreferenceKey(userId, workspaceId)
      if (localStorage.getItem(key) === id) localStorage.removeItem(key)
      window.dispatchEvent(new Event(ACCOUNT_CHANGED))
    }
    return
  }
  if (localStorage.getItem(LEGACY_KEY) === id) localStorage.removeItem(LEGACY_KEY)
}

export function rememberedAccount(userId?: string, workspaceId?: string) {
  if (isElectronDesktop(navigator.userAgent)) {
    return userId && workspaceId
      ? localStorage.getItem(currentAccountPreferenceKey(userId, workspaceId))
      : null
  }
  return localStorage.getItem(LEGACY_KEY)
}

export function useCurrentAccountSelection() {
  const location = useLocation()
  const me = useMe()
  const accounts = useAccounts()
  const desktop = isElectronDesktop(navigator.userAgent)
  const accountMatch = location.pathname.match(/^\/a\/([^/]+)/)
  const workMatch = location.pathname.match(/^\/works\/([^/]+)/)
  const work = useQuery<Work>({
    queryKey: currentWorkQueryKey(workMatch?.[1] ?? '', me.data?.user_id ?? me.data?.username ?? '', me.data?.workspace.id ?? ''),
    queryFn: () => get<Work>(`/works/${workMatch![1]}`),
    enabled: !!workMatch && !!me.data?.workspace.id,
    staleTime: 30_000,
  })
  const [, setRevision] = useState(0)
  const userId = me.data ? me.data.user_id ?? me.data.username : undefined
  const workspaceId = me.data?.workspace.id

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener(ACCOUNT_CHANGED, refresh)
    return () => {
      window.removeEventListener(ACCOUNT_CHANGED, refresh)
    }
  }, [])

  const routeId = workMatch ? work.data?.account_id : accountMatch?.[1]
  const preferredId = desktop ? rememberedAccount(userId, workspaceId) : rememberedAccount()
  const selectedId = workMatch ? routeId : routeId ?? preferredId
  const account = accounts.data?.find((item) => item.id === selectedId)
    ?? (!desktop && !routeId ? accounts.data?.find((item) => item.status === 'active') : undefined)

  useEffect(() => {
    if (!account || desktop) return
    rememberAccount(account.id, userId, workspaceId)
  }, [account?.id, desktop, userId, workspaceId])

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

/** 桌面端以账号路由或用户/工作区偏好为准；普通 Web 延续历史默认账号行为。 */
export function useCurrentAccount(): Account | undefined {
  return useCurrentAccountSelection().account
}

export function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: unknown[][]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}
