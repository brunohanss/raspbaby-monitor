package org.raspbaby.background

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*

/** Keeps the process eligible for background playback; the WebView owns WebRTC. */
class MonitorService : Service() {
    companion object {
        internal var active = false
        internal var reason: String? = null
        internal var onChanged: ((Boolean) -> Unit)? = null
        internal var onStarted: ((String?) -> Unit)? = null
        private var instance: MonitorService? = null
        internal fun heartbeat() { instance?.renew() }
        internal fun stop(reason: String, stopPlayback: Boolean = true) { instance?.finish(reason, stopPlayback) }
        private const val CHANNEL = "raspbaby-monitoring"
        private const val NOTIFICATION = 4201
        private const val STOP = "org.raspbaby.background.STOP"
    }

    private val handler = Handler(Looper.getMainLooper())
    private val lease = PlaybackLease()
    private var wakeLock: PowerManager.WakeLock? = null
    private val watchdog = object : Runnable {
        override fun run() {
            if (!lease.isFresh(SystemClock.elapsedRealtime())) finish("Media progress stopped")
            else handler.postDelayed(this, 5_000)
        }
    }

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            finish("Stopped from notification")
            return START_NOT_STICKY
        }
        // Never restart a playback claim after process death.
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val manager = getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(NotificationChannel(CHANNEL, "Live monitoring", NotificationManager.IMPORTANCE_LOW))
            }
            val open = packageManager.getLaunchIntentForPackage(packageName)!!.apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            val immutable = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val reopen = PendingIntent.getActivity(this, 0, open, immutable)
            val stop = PendingIntent.getService(this, 1, Intent(this, MonitorService::class.java).setAction(STOP), immutable)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
            val notification = builder
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("Raspbaby is monitoring")
                .setContentText("Live camera playback. Tap to open.")
                .setContentIntent(reopen)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop monitoring", stop).build())
                .build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(NOTIFICATION, notification)
            instance = this
            active = true
            reason = null
            renew()
            handler.removeCallbacks(watchdog)
            handler.postDelayed(watchdog, 5_000)
            onChanged?.invoke(false)
            onStarted?.invoke(null)
            onStarted = null
        } catch (error: Exception) {
            onStarted?.invoke(error.message ?: "Could not start background playback")
            onStarted = null
            finish("Background service failed")
        }
        return START_NOT_STICKY
    }

    private fun renew() {
        lease.renew(SystemClock.elapsedRealtime())
        if (wakeLock == null) {
            wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Raspbaby:LivePlayback")
                .apply { setReferenceCounted(false) }
        }
        // The OS also expires this lock if the process stops reporting media progress.
        wakeLock?.acquire(35_000)
    }

    private fun finish(message: String, stopPlayback: Boolean = true) {
        reason = message
        release(stopPlayback)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun release(stopPlayback: Boolean = true) {
        handler.removeCallbacks(watchdog)
        lease.clear()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        val wasActive = active
        active = false
        instance = null
        if (wasActive) onChanged?.invoke(stopPlayback)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        finish("App task removed")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (active) reason = "Background service stopped"
        release()
        super.onDestroy()
    }
}
