package com.arimaops.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class PushService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        for (String server : getSharedPreferences("servers", MODE_PRIVATE).getStringSet("saved", java.util.Set.of())) {
            if (!ServerUrl.sameOrigin(server, server)) continue;
            String cookies = android.webkit.CookieManager.getInstance().getCookie(server);
            if (cookies == null || !cookies.contains("hq_sid=")) continue;
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection) new java.net.URL(server + "/api/push/register").openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Origin", server);
                connection.setRequestProperty("Cookie", cookies);
                connection.setRequestProperty("Content-Type", "application/json");
                try (var output = connection.getOutputStream()) {
                    output.write(new org.json.JSONObject().put("token", token).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                connection.getResponseCode();
            } catch (java.io.IOException | org.json.JSONException error) {
                // Offline or signed out: the WebView retries with the current token on the next resume.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        var data = message.getData();
        String server = data.get("server");
        String path = data.get("path");
        if (!ServerUrl.sameOrigin(server, server) || ServerUrl.deepLink(server, path) == null) return;
        // Never accept a notification for a server this installation has not connected to.
        if (!getSharedPreferences("servers", MODE_PRIVATE).getStringSet("saved", java.util.Set.of()).contains(server)) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("hq-alerts", "HQ alerts", NotificationManager.IMPORTANCE_HIGH));
        Uri link = new Uri.Builder().scheme("arimaops").authority("open")
            .appendQueryParameter("path", path).appendQueryParameter("server", server).build();
        Intent intent = new Intent(Intent.ACTION_VIEW, link, this, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String id = message.getMessageId();
        manager.notify(id == null ? link.toString().hashCode() : id.hashCode(), new Notification.Builder(this, "hq-alerts")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(data.getOrDefault("title", "ArimaOps"))
            .setContentText(data.getOrDefault("body", "Open your HQ to see the update."))
            .setStyle(new Notification.BigTextStyle().bigText(data.getOrDefault("body", "")))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(tap).setAutoCancel(true).build());
    }
}
