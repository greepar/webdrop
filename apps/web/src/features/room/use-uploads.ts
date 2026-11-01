import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError, isApiError } from '@/shared/api/errors'
import { cancelUpload, completeUpload, createUpload, fetchUploadStatus, uploadContent } from '@/features/room/api'
import { newIdempotencyKey } from '@/shared/api/session-token'
import type { Asset, RoomItem } from '@/shared/types/domain'

export type UploadEntry = {
  localId: string
  file: File
  asset: Asset
  status: 'uploading' | 'failed' | 'cancelled'
  cancelPending: boolean
  uploadId: string | null
  uploadUrl: string | null
  createKey: string
  completeKey: string
  progress: { loaded: number; total: number } | null
  error: string | null
}

// Uploads run concurrently; each has its own AbortController. A completed upload is removed from the
// local queue once the server returns the ready message, so the same file never appears twice.
export function useUploads(roomId: string, onComplete: (item: RoomItem) => void) {
  const [entries, setEntries] = useState<UploadEntry[]>([])
  const entriesRef = useRef<UploadEntry[]>([])
  const controllers = useRef(new Map<string, AbortController>())

  const cancelling = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const active = controllers.current
    return () => {
      mounted.current = false
      active.forEach((controller) => controller.abort())
      entriesRef.current.forEach((entry) => {
        if (entry.uploadId && active.has(entry.localId)) void cancelUpload(entry.uploadId).catch(() => undefined)
      })
    }
  }, [])

  const commit = useCallback((next: UploadEntry[]) => {
    entriesRef.current = next
    if (mounted.current) setEntries(next)
  }, [])

  const patch = useCallback((localId: string, changes: Partial<UploadEntry>) => {
    commit(entriesRef.current.map((e) => (e.localId === localId ? { ...e, ...changes, asset: { ...e.asset, ...(changes.status ? { status: changes.status } : {}) } } : e)))
  }, [commit])

  const run = useCallback(async (localId: string) => {
    const entry = entriesRef.current.find((e) => e.localId === localId)
    if (!entry || controllers.current.has(localId) || cancelling.current.has(localId)) return
    const controller = new AbortController()
    controllers.current.set(localId, controller)
    patch(localId, { status: 'uploading', cancelPending: false, error: null, progress: { loaded: 0, total: entry.file.size } })
    try {
      let uploadId = entry.uploadId
      let uploadUrl = entry.uploadUrl
      if (!uploadId || !uploadUrl) {
        const created = await createUpload(roomId, entry.file, entry.createKey)
        uploadId = created.uploadId
        uploadUrl = created.uploadUrl
        patch(localId, { uploadId, uploadUrl })
        if (controller.signal.aborted) {
          await cancelUpload(uploadId)
          controller.signal.throwIfAborted()
        }
      }
      const status = await fetchUploadStatus(uploadId, controller.signal)
      if (status.status === 'uploading') {
        patch(localId, { status: 'failed', progress: null, error: '文件仍在处理，请稍后重试' })
        controllers.current.delete(localId)
        return
      }
      if (status.status === 'cancelled' || status.status === 'expired') {
        patch(localId, { uploadId: null, uploadUrl: null, createKey: newIdempotencyKey(), completeKey: newIdempotencyKey() })
        throw new Error('本次上传已结束，请重试')
      }
      if (status.status === 'pending' || status.status === 'failed') {
        await uploadContent(uploadUrl, entry.file, {
          signal: controller.signal,
          onProgress: (loaded, total) => patch(localId, { progress: { loaded, total } }),
        })
      }
      const item = await completeUpload(uploadId, entry.completeKey, controller.signal)
      controller.signal.throwIfAborted()
      controllers.current.delete(localId)
      commit(entriesRef.current.filter((e) => e.localId !== localId))
      if (mounted.current) onComplete(item)
    } catch (error) {
      controllers.current.delete(localId)
      if (isAbortError(error)) {
        if (cancelling.current.has(localId)) return
        patch(localId, { status: 'cancelled', cancelPending: false, progress: null })
        return
      }
      if (isApiError(error) && [404, 410].includes(error.status)) {
        patch(localId, { uploadId: null, uploadUrl: null, createKey: newIdempotencyKey(), completeKey: newIdempotencyKey() })
      }
      patch(localId, { status: 'failed', cancelPending: false, progress: null, error: describeUploadError(error) })
    }
  }, [commit, onComplete, patch, roomId])

  const start = useCallback((files: File[]) => {
    const created: UploadEntry[] = files.map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      asset: {
        id: '',
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type || 'application/octet-stream',
        sha256: null,
        status: 'uploading',
        createdAt: new Date().toISOString(),
      },
      status: 'uploading',
      cancelPending: false,
      uploadId: null,
      uploadUrl: null,
      createKey: newIdempotencyKey(),
      completeKey: newIdempotencyKey(),
      progress: { loaded: 0, total: file.size },
      error: null,
    }))
    commit([...entriesRef.current, ...created])
    created.forEach((entry) => void run(entry.localId))
  }, [commit, run])

  const cancel = useCallback((localId: string) => {
    const entry = entriesRef.current.find((e) => e.localId === localId)
    if (!entry || entry.cancelPending) return
    patch(localId, { cancelPending: true, error: null })
    controllers.current.get(localId)?.abort()
    if (entry.uploadId) {
      cancelling.current.add(localId)
      void cancelUpload(entry.uploadId)
        .then(() => patch(localId, { status: 'cancelled', cancelPending: false, progress: null, uploadId: null, uploadUrl: null, createKey: newIdempotencyKey(), completeKey: newIdempotencyKey() }))
        .catch(() => patch(localId, { status: 'failed', cancelPending: false, progress: null, error: '没能确认取消结果，重试时会先查询上传状态' }))
        .finally(() => cancelling.current.delete(localId))
    }
    else if (!controllers.current.has(localId)) patch(localId, { status: 'cancelled', cancelPending: false, progress: null })
  }, [patch])

  const retry = useCallback((localId: string) => {
    void run(localId)
  }, [run])

  const abortAll = useCallback(() => {
    controllers.current.forEach(controller => controller.abort())
    commit(entriesRef.current.map(entry => ({ ...entry, status: 'cancelled', cancelPending: false, progress: null, asset: { ...entry.asset, status: 'cancelled' } })))
  }, [commit])

  const dismiss = useCallback((localId: string) => {
    commit(entriesRef.current.filter((e) => e.localId !== localId))
  }, [commit])

  return { entries, start, cancel, retry, dismiss, abortAll }
}

// Surface the real failure reason instead of blaming a closed room for everything.
function describeUploadError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'UPLOAD_TIMEOUT') return '上传超时，请重试'
    if (error.code === 'FILE_TOO_LARGE') return '文件超过大小上限'
    if (error.code === 'QUOTA_EXCEEDED') return '房间存储已满，请联系房主清理'
    if (error.code === 'ROOM_CAPACITY' || error.code === 'CAPACITY') {
      return error.retryAfter ? `服务繁忙，${error.retryAfter} 秒后重试` : '服务繁忙，请稍后重试'
    }
    if (error.code === 'ROOM_FULL') return '房间人数已满'
    if (error.code === 'INVALID_INPUT') return '文件信息无效，请换个文件重试'
    if (error.status === 429) return error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试'
    if ([401, 403, 404].includes(error.status)) return '房间不可用，请返回首页重新进入'
    if (error.status === 0 || error.status >= 500) return '网络不稳定，点重试继续上传'
  }
  return '上传未完成，请点重试'
}
