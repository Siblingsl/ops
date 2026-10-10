import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { get, setCsrf } from './api'
import type { Account, Me, SystemInfo } from './types'

export function useMe() {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (q.data) setCsrf(q.data.csrf_token)
  }, [q.data])
  return q
}

/** Viewer role is read-only (FR-M1-06 / D-038); writing is blocked server-side too. */
export function useCanWrite() {
  const { data: me } = useMe()
  return me?.role !== 'viewer'
}

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: () => get<Account[]>('/accounts'), staleTime: 30_000 })
}

export function useSystemInfo() {
  return useQuery({ queryKey: ['system'], queryFn: () => get<SystemInfo>('/system/info'), staleTime: 300_000 })
}

const KEY = 'ops.currentAccount'
export const rememberAccount = (id: string) => localStorage.setItem(KEY, id)
export const rememberedAccount = () => localStorage.getItem(KEY)

/** useCurrentAccount resolves the account from the URL, falling back to the remembered one. */
export function useCurrentAccount(): Account | undefined {
  const { accountId } = useParams()
  const { data } = useAccounts()
  const id = accountId || rememberedAccount()
  const acc = data?.find((a) => a.id === id) ?? data?.find((a) => a.status === 'active')
  useEffect(() => {
    if (acc) rememberAccount(acc.id)
  }, [acc])
  return acc
}

export function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: unknown[][]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })))
}
