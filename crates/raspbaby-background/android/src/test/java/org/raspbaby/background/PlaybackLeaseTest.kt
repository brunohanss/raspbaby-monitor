package org.raspbaby.background

import org.junit.Assert.*
import org.junit.Test

class PlaybackLeaseTest {
    @Test fun onlyRecentProgressKeepsLease() {
        val lease = PlaybackLease()
        assertFalse(lease.isFresh(0))
        lease.renew(100)
        assertTrue(lease.isFresh(30_099))
        assertFalse(lease.isFresh(30_100))
        lease.renew(30_100)
        assertTrue(lease.isFresh(30_101))
        lease.clear()
        assertFalse(lease.isFresh(30_102))
    }
    @Test fun clockRegressionDoesNotExtendSession() {
        val lease = PlaybackLease()
        lease.renew(100)
        assertFalse(lease.isFresh(99))
    }
}
