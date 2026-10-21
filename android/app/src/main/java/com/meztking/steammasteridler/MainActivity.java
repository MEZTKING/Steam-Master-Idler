package com.meztking.steammasteridler;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;

/** Shows the idler's page (the same one as the desktop app) from the server running in IdleService. */
public class MainActivity extends Activity {
    private static final String BG = "#0f141b";
    private static final String SPLASH = "<html><body style='margin:0;background:" + BG + ";color:#8a98a8;"
            + "font:16px system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center'>"
            + "Starting Steam Master Idler…</body></html>";

    private WebView web;
    private String base;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long waitingSince;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(0xff171e27);

        web = new WebView(this);
        web.setBackgroundColor(0xff0f141b);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // the page remembers the theme and tab in localStorage
        web.setWebChromeClient(new WebChromeClient());   // alert()/confirm() dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (base != null && url.startsWith(base)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));   // other sites: the browser
                return true;
            }
        });
        // "Save debug report": hand the file to the share sheet (Discord, email, Drive, …)
        web.setDownloadListener((url, ua, disposition, mime, length) -> shareDownload(url, disposition, mime));
        web.loadDataWithBaseURL(null, SPLASH, "text/html", "utf-8", null);

        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
        IdleService.start(this);
        waitingSince = System.currentTimeMillis();
        handler.post(this::waitForServer);
        askToIgnoreBatteryOptimizations();
    }

    private void waitForServer() {
        String url = LocalServer.url(this);
        if (url != null) {
            base = url;
            web.loadUrl(url + "/");
            return;
        }
        if (System.currentTimeMillis() - waitingSince > 60_000) {
            web.loadDataWithBaseURL(null, SPLASH.replace("Starting Steam Master Idler…",
                    "The idler didn't start. Close the app from Recents and open it again."), "text/html", "utf-8", null);
            return;
        }
        handler.postDelayed(this::waitForServer, 300);
    }

    private void shareDownload(String url, String disposition, String mime) {
        new Thread(() -> {
            try {
                String path = url.substring(url.indexOf('/', url.indexOf("//") + 2));
                byte[] body = LocalServer.request(this, "GET", path);
                String name = URLUtil.guessFileName(url, disposition, mime);
                File dir = new File(getCacheDir(), "reports");
                dir.mkdirs();
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) { out.write(body); }
                Uri uri = ReportProvider.uriFor(this, file);
                Intent send = new Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .putExtra(Intent.EXTRA_SUBJECT, name)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "Send debug report")));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Couldn't save the report: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    /** Long idling needs the app to be exempt from battery optimisation; ask once. */
    private void askToIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < 23) return;
        PowerManager pm = getSystemService(PowerManager.class);
        SharedPreferences prefs = getSharedPreferences("ui", MODE_PRIVATE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName()) || prefs.getBoolean("askedBattery", false)) return;
        prefs.edit().putBoolean("askedBattery", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("Keep idling in the background")
                .setMessage("Android pauses apps in the background to save battery, which would stop idling. "
                        + "Allow Steam Master Idler to run unrestricted?")
                .setPositiveButton("Allow", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    }
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // keep idling; quit from the notification
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
