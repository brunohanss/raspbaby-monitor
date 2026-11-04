package org.raspbaby.background

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class BackgroundMonitorPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var resumed = true
    private var pending: Invoke? = null
    private val handler = Handler(Looper.getMainLooper())
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() { activity.moveTaskToBack(true) }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(activity, back)
        MonitorService.onChanged = { stopPlayback ->
            back.isEnabled = MonitorService.active
            if (!MonitorService.active) {
                // A notification stop must close the receiver, including when hidden.
                if (stopPlayback) webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('raspbaby-background-stop'))", null)
                if (!resumed) webView.onPause()
            }
        }
    }

    @Command fun start(invoke: Invoke) {
        if (!resumed || activity.isFinishing || activity.isDestroyed) {
            invoke.reject("Open the app before starting background monitoring")
            return
        }
        if (MonitorService.active) { invoke.resolve(snapshot()); return }
        if (pending != null) { invoke.reject("Background monitoring is already starting"); return }
        pending = invoke
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notifications", invoke, "notificationResult")
        } else startService(invoke)
    }

    @PermissionCallback fun notificationResult(invoke: Invoke) {
        if (pending !== invoke) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pending = null
            invoke.reject("Allow notifications to use background monitoring")
        } else startService(invoke)
    }

    private fun startService(invoke: Invoke) {
        if (pending !== invoke) return
        if (!resumed || !activity.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            pending = null
            invoke.reject("Open the app and enable notifications before starting background monitoring")
            return
        }
        MonitorService.onStarted = { error ->
            pending = null
            if (error == null) invoke.resolve(snapshot()) else invoke.reject(error)
        }
        try {
            ContextCompat.startForegroundService(activity, Intent(activity, MonitorService::class.java))
            handler.postDelayed({
                if (pending === invoke) {
                    pending = null
                    MonitorService.onStarted = null
                    activity.stopService(Intent(activity, MonitorService::class.java))
                    invoke.reject("Background service did not start")
                }
            }, 5_000)
        } catch (error: Exception) {
            pending = null
            MonitorService.onStarted = null
            invoke.reject(error.message ?: "Could not start background monitoring")
        }
    }

    @Command fun stop(invoke: Invoke) {
        pending?.reject("Background monitoring was cancelled")
        pending = null
        MonitorService.onStarted = null
        MonitorService.stop("Background monitoring disabled", stopPlayback = false)
        activity.stopService(Intent(activity, MonitorService::class.java))
        invoke.resolve(snapshot())
    }

    @Command fun status(invoke: Invoke) { invoke.resolve(snapshot()) }

    @Command fun heartbeat(invoke: Invoke) {
        MonitorService.heartbeat()
        invoke.resolve(snapshot())
    }

    private fun snapshot() = JSObject().apply {
        put("supported", true)
        put("active", MonitorService.active)
        put("reason", MonitorService.reason)
    }

    override fun onPause(activity: AppCompatActivity) {
        resumed = false
        // WryActivity.onPause pauses WebView before this hook. Only a live, explicit
        // session may resume it. No fake audio or video is used to keep it alive.
        if (MonitorService.active) webView?.onResume()
    }

    override fun onResume(activity: AppCompatActivity) { resumed = true }

    override fun onDestroy(activity: AppCompatActivity) {
        MonitorService.stop("Playback view destroyed")
        activity.stopService(Intent(activity, MonitorService::class.java))
        MonitorService.onChanged = null
        MonitorService.onStarted = null
        pending?.reject("Playback view destroyed")
        pending = null
        handler.removeCallbacksAndMessages(null)
        webView = null
    }
}
