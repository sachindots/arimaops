package com.arimaops.app;

import android.app.Activity;
import android.Manifest;
import android.content.pm.PackageManager;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.content.pm.ApplicationInfo;
import android.window.OnBackInvokedDispatcher;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.stream.Collectors;
import java.util.HashSet;
import java.util.Set;
import com.google.firebase.messaging.FirebaseMessaging;

public final class MainActivity extends Activity {
    private static final String CONNECT_ORIGIN = "https://connect.arimaops.invalid";
    private WebView web;
    private SharedPreferences preferences;
    private String server;
    private String pendingPath;
    private boolean choosing;
    private boolean clearHistory;
    private AlertDialog loadError;
    private WebMessagePort[] bridgePorts;
    private Runnable afterNotificationPermission;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("servers", MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        server = ServerUrl.origin(preferences.getString("current", ""));
        readDeepLink(getIntent());
        if (server == null) showConnect();
        else openServer(server);
    }

    private void createWebView() {
        if (web != null) {
            CookieManager.getInstance().flush();
            closeBridge();
            web.destroy();
        }
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.setBackgroundColor(0xff10151c);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (choosing && request.isForMainFrame() && "arima-connect".equals(uri.getScheme()) && "connect".equals(uri.getHost())) {
                    connect(uri.getQueryParameter("url"));
                    return true;
                }
                if (!choosing && ServerUrl.sameOrigin(server, uri.toString())) return false;
                if (request.isForMainFrame()) openExternal(uri);
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                closeBridge();
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (clearHistory) { web.clearHistory(); clearHistory = false; }
                if (!choosing && ServerUrl.sameOrigin(server, url) && ServerUrl.sameOrigin(server, web.getUrl())) attachBridge();
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!choosing && request.isForMainFrame()) showLoadError();
            }
        });
        setContentView(web);
        getWindow().setDecorFitsSystemWindows(false);
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            var edges = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            return insets;
        });
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) {
            controller.hide(WindowInsets.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private void showConnect() {
        choosing = true;
        createWebView();
        try (var input = getAssets().open("connect.html")) {
            String html = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8)).lines().collect(Collectors.joining("\n"));
            JSONArray saved = new JSONArray();
            for (String url : preferences.getStringSet("saved", Set.of())) saved.put(url);
            html = html.replace("{{SERVERS}}", saved.toString().replace("<", "\\u003c"));
            web.loadDataWithBaseURL(CONNECT_ORIGIN + "/", html, "text/html", "UTF-8", null);
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Missing connection screen", error);
        }
    }

    private void connect(String value) {
        String origin = value == null ? null : ServerUrl.origin(value);
        if (origin == null) {
            web.evaluateJavascript("document.querySelector('#error').textContent='Enter an HTTPS server URL (or HTTP localhost).';", null);
            return;
        }
        server = origin;
        Set<String> saved = new HashSet<>(preferences.getStringSet("saved", Set.of()));
        saved.add(origin);
        preferences.edit().putString("current", origin).putStringSet("saved", saved).apply();
        openServer(value.trim());
    }

    private void openServer(String url) {
        choosing = false;
        createWebView();
        clearHistory = true;
        // Complete a pasted bootstrap/sign-in URL before following a pending notification.
        web.loadUrl(url);
    }

    private void attachBridge() {
        closeBridge();
        WebView view = web;
        String origin = server;
        WebMessagePort[] ports = view.createWebMessageChannel();
        bridgePorts = ports;
        ports[0].setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
                if (bridgePorts != ports || choosing || !ServerUrl.sameOrigin(origin, view.getUrl())) return;
                if ("switchServer".equals(message.getData())) showConnect();
                else if ("pushToken".equals(message.getData())) requestPushToken(ports, origin);
            }
        });
        // Deliver a capability to the main frame at this exact origin; no interface is exposed to iframes.
        String script = "(() => { if(location.origin !== " + JSONObject.quote(origin) + ") return;"
            + "window.addEventListener('message', function receive(e) {"
            + "if(e.data !== 'arima-native-port' || e.ports.length !== 1) return;"
            + "window.removeEventListener('message', receive); const port = e.ports[0];"
            + "let pending; const pushToken = () => pending ||= new Promise((resolve, reject) => {"
            + "port.onmessage = event => { pending = null; const result = JSON.parse(event.data);"
            + "if(result.error) reject(new Error(result.error)); else resolve(result.token); }; port.postMessage('pushToken'); });"
            + "window.ArimaNative = Object.freeze({platform: () => 'android', switchServer: () => port.postMessage('switchServer'), pushToken});"
            + "window.dispatchEvent(new Event('arima-native-ready')); }); })()";
        view.evaluateJavascript(script, ignored -> {
            if (bridgePorts == ports && !choosing && ServerUrl.sameOrigin(origin, view.getUrl())) {
                view.postWebMessage(new WebMessage("arima-native-port", new WebMessagePort[]{ports[1]}), Uri.parse(origin));
                if (pendingPath != null) {
                    String target = ServerUrl.deepLink(origin, pendingPath);
                    pendingPath = null;
                    if (target != null) view.loadUrl(target);
                }
            }
        });
    }

    private void closeBridge() {
        if (bridgePorts == null) return;
        // The other port belongs to JavaScript after transfer and must not be closed from Java.
        bridgePorts[0].close();
        bridgePorts = null;
    }

    private void requestPushToken(WebMessagePort[] ports, String origin) {
        Runnable respond = () -> {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                replyPushToken(ports, origin, null, null);
                return;
            }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task ->
                replyPushToken(ports, origin, task.isSuccessful() ? task.getResult() : null,
                    task.isSuccessful() ? null : "Could not register with Firebase. Check your connection."));
        };
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !preferences.getBoolean("notificationsRequested", false)) {
            preferences.edit().putBoolean("notificationsRequested", true).apply();
            afterNotificationPermission = respond;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else respond.run();
    }

    private void replyPushToken(WebMessagePort[] ports, String origin, String token, String error) {
        if (bridgePorts != ports || choosing || !ServerUrl.sameOrigin(origin, web.getUrl())) return;
        try {
            JSONObject result = new JSONObject();
            result.put("token", token == null ? JSONObject.NULL : token);
            if (error != null) result.put("error", error);
            ports[0].postMessage(new WebMessage(result.toString()));
        } catch (org.json.JSONException errorWritingResponse) {
            throw new IllegalStateException(errorWritingResponse);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1 && afterNotificationPermission != null) {
            Runnable respond = afterNotificationPermission;
            afterNotificationPermission = null;
            respond.run();
        }
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!Set.of("https", "http", "mailto", "tel").contains(scheme == null ? "" : scheme)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_LONG).show(); }
    }

    private void showLoadError() {
        if (isFinishing() || loadError != null) return;
        loadError = new AlertDialog.Builder(this).setTitle("Cannot reach your HQ")
            .setMessage("Check your connection and Tailscale, then try again.")
            .setPositiveButton("Retry", (dialog, which) -> web.reload())
            .setNeutralButton("Switch server", (dialog, which) -> showConnect()).create();
        loadError.setOnDismissListener(dialog -> loadError = null);
        loadError.show();
    }

    private void readDeepLink(Intent intent) {
        Uri uri = intent.getData();
        if (uri != null && "arimaops".equals(uri.getScheme()) && "open".equals(uri.getHost())) {
            String path = uri.getQueryParameter("path");
            if (ServerUrl.deepLink("https://validation.invalid", path) == null) return;
            String targetServer = uri.getQueryParameter("server");
            if (targetServer != null) {
                if (!preferences.getStringSet("saved", Set.of()).contains(targetServer) || ServerUrl.origin(targetServer) == null) return;
                server = targetServer;
                preferences.edit().putString("current", server).apply();
            }
            pendingPath = path;
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readDeepLink(intent);
        if (server != null && pendingPath != null) {
            String target = ServerUrl.deepLink(server, pendingPath);
            pendingPath = null;
            if (target != null) openServer(target);
        }
    }

    // API 31–32 fallback; newer Android versions use the registered OnBackInvokedCallback.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (choosing) {
            if (server != null) openServer(server);
            else super.onBackPressed();
            return;
        }
        web.evaluateJavascript("Boolean(window.__arimaBack?.())", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (web != null && !choosing && ServerUrl.sameOrigin(server, web.getUrl()))
            web.evaluateJavascript("window.dispatchEvent(new Event('arima-native-resume'))", null);
    }

    @Override protected void onDestroy() {
        if (loadError != null) loadError.dismiss();
        closeBridge();
        web.destroy();
        super.onDestroy();
    }
}
