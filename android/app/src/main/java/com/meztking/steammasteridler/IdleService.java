package com.meztking.steammasteridler;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps the app (and so the idler) running in the background, with a notification showing what's
 * idling. Android would otherwise stop the app soon after you leave it.
 */
public class IdleService extends Service {
    private static final String TAG = "SteamMasterIdler";
    private static final String CHANNEL = "idling";
    private static final int NOTIFICATION_ID = 1;
    static final String ACTION_QUIT = "com.meztking.steammasteridler.QUIT";

    private PowerManager.WakeLock wakeLock;
    private volatile boolean running;
    private String lastText = "";

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, IdleService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Idling status", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows what Steam Master Idler is doing while it runs in the background");
            nm.createNotificationChannel(ch);
        }
        Notification n = build("Starting…");
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, n);

        // keep the CPU awake enough to stay connected to Steam while the screen is off
        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SteamMasterIdler:idling");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        NodeRunner.start(this);
        running = true;
        new Thread(this::statusLoop, "status").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_QUIT.equals(intent.getAction())) {
            quit();
            return START_NOT_STICKY;
        }
        return START_STICKY;   // if Android kills us, come back (the idler then resumes what it was doing)
    }

    /** Stop idling, log off Steam and end the app. */
    private void quit() {
        running = false;
        new Thread(() -> {
            try { LocalServer.post(this, "/api/quit"); } catch (Exception e) { Log.w(TAG, "quit", e); }
            stopForeground(true);
            stopSelf();
            // Node.js exits the process itself after logging off; this is the fallback
            try { Thread.sleep(4000); } catch (InterruptedException ignored) {}
            android.os.Process.killProcess(android.os.Process.myPid());
        }).start();
    }

    /** Refresh the notification text from the idler's state every 15 seconds. */
    private void statusLoop() {
        while (running) {
            try {
                JSONObject s = new JSONObject(LocalServer.get(this, "/api/state"));
                update(describe(s));
            } catch (Exception e) {
                // server still starting
            }
            try { Thread.sleep(15_000); } catch (InterruptedException ignored) { return; }
        }
    }

    private static String describe(JSONObject s) {
        String status = s.optString("status");
        if (!"loggedIn".equals(status)) return "loggedOut".equals(status) ? "Not logged in. Tap to open." : "Signing in…";
        JSONObject session = s.optJSONObject("session");
        if (session == null) return "Ready. Not idling.";
        if (session.optBoolean("effectivePaused")) return "Paused";
        JSONArray games = session.optJSONArray("games");
        int active = 0;
        String first = null;
        for (int i = 0; games != null && i < games.length(); i++) {
            JSONObject g = games.optJSONObject(i);
            if (g.optBoolean("active") && !g.optBoolean("done")) {
                active++;
                if (first == null) first = g.optString("name");
            }
        }
        long secs = session.optLong("idledMs") / 1000;
        String time = String.format(java.util.Locale.US, "%d:%02d:%02d", secs / 3600, (secs / 60) % 60, secs % 60);
        if (active == 1) return "Idling " + first + " · " + time;
        return "Idling " + active + " games · " + time;
    }

    private void update(String text) {
        if (text.equals(lastText)) return;
        lastText = text;
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, build(text));
    }

    private Notification build(String text) {
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable);
        PendingIntent quit = PendingIntent.getService(this, 1,
                new Intent(this, IdleService.class).setAction(ACTION_QUIT), immutable);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat_idle)
                .setContentTitle("Steam Master Idler")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Quit", quit).build())
                .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
