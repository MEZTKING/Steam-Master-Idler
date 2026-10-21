package com.meztking.steammasteridler;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Talks to the idler's server running inside this app (on 127.0.0.1). */
final class LocalServer {
    private LocalServer() {}

    /** e.g. http://127.0.0.1:41234, or null while the server is still starting. */
    static String url(Context ctx) {
        File f = NodeRunner.urlFile(ctx);
        if (!f.exists()) return null;
        try (InputStream in = new FileInputStream(f)) {   // (java.nio.file needs Android 8+)
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return null;
        }
    }

    static String get(Context ctx, String path) throws IOException {
        return new String(request(ctx, "GET", path), StandardCharsets.UTF_8);
    }

    static String post(Context ctx, String path) throws IOException {
        return new String(request(ctx, "POST", path), StandardCharsets.UTF_8);
    }

    static byte[] request(Context ctx, String method, String path) throws IOException {
        String base = url(ctx);
        if (base == null) throw new IOException("server not running yet");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(15000);
        c.setRequestMethod(method);
        if ("POST".equals(method)) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write("{}".getBytes(StandardCharsets.UTF_8)); }
        }
        try (InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream()) {
            return in == null ? new byte[0] : readAll(in);
        } finally {
            c.disconnect();
        }
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
