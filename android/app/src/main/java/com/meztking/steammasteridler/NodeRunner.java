package com.meztking.steammasteridler;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs the idler's Node.js server (the same code as the desktop app) inside this app.
 * Node.js can only start once per process, so this is a one-shot per process.
 */
public final class NodeRunner {
    private static final String TAG = "SteamMasterIdler";

    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private static native int startNodeWithArguments(String[] args);

    private static boolean started;

    private NodeRunner() {}

    public static File dataDir(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "data");
        dir.mkdirs();
        return dir;
    }

    /** The server writes its address here once it's listening. */
    public static File urlFile(Context ctx) {
        return new File(dataDir(ctx), "server-url.txt");
    }

    public static synchronized void start(Context context) {
        if (started) return;
        started = true;
        final Context ctx = context.getApplicationContext();
        urlFile(ctx).delete();
        // V8 wants a bigger stack than Android's default thread stack
        Thread thread = new Thread(null, () -> {
            try {
                File project = extractProject(ctx);
                String script = new File(project, "src/mobile.js").getAbsolutePath();
                int code = startNodeWithArguments(new String[] { "node", script, dataDir(ctx).getAbsolutePath() });
                Log.w(TAG, "Node.js exited with code " + code);
            } catch (Throwable t) {
                Log.e(TAG, "Couldn't start Node.js", t);
            }
        }, "nodejs", 16 * 1024 * 1024);
        thread.start();
    }

    /** Unpacks assets/nodejs-project.zip, but only after an install or update. */
    private static File extractProject(Context ctx) throws Exception {
        File target = new File(ctx.getFilesDir(), "nodejs-project");
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        String stamp = info.versionName + "/" + info.lastUpdateTime;
        SharedPreferences prefs = ctx.getSharedPreferences("node", Context.MODE_PRIVATE);
        if (stamp.equals(prefs.getString("extracted", null)) && new File(target, "src/mobile.js").exists()) {
            return target;
        }
        deleteRecursively(target);
        target.mkdirs();
        String root = target.getCanonicalPath() + File.separator;
        try (InputStream in = ctx.getAssets().open("nodejs-project.zip"); ZipInputStream zip = new ZipInputStream(in)) {
            byte[] buf = new byte[64 * 1024];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(target, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("bad zip entry " + entry.getName());
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
        }
        prefs.edit().putString("extracted", stamp).apply();
        Log.i(TAG, "Unpacked the idler to " + target);
        return target;
    }

    private static void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursively(c);
        f.delete();
    }
}
