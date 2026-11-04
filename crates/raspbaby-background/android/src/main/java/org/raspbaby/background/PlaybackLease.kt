package org.raspbaby.background

/** No persisted session. Only fresh receiver progress can renew this lease. */
internal class PlaybackLease(private val timeoutMillis: Long = 30_000) {
    private var updatedAt: Long? = null
    fun renew(now: Long) { updatedAt = now }
    fun clear() { updatedAt = null }
    fun isFresh(now: Long): Boolean = updatedAt?.let { now >= it && now - it < timeoutMillis } ?: false
}
