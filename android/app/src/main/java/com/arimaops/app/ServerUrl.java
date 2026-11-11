package com.arimaops.app;

import java.net.URI;
import java.util.Locale;

/** The saved server is an origin; bootstrap tokens stay only in the initial navigation. */
final class ServerUrl {
    static String origin(String value) {
        try {
            URI uri = new URI(value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]");
            if (host.isEmpty() || uri.getRawUserInfo() != null ||
                    !(scheme.equals("https") || (scheme.equals("http") && local))) return null;
            int port = uri.getPort();
            if (port == 0 || port > 65535) return null;
            boolean defaultPort = port == -1 || port == (scheme.equals("https") ? 443 : 80);
            return scheme + "://" + host + (defaultPort ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean sameOrigin(String server, String url) {
        return server != null && server.equals(origin(url == null ? "" : url));
    }

    static String deepLink(String server, String path) {
        if (server == null || path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("\\")) return null;
        try {
            URI resolved = new URI(server).resolve(new URI(path));
            return sameOrigin(server, resolved.toString()) ? resolved.toASCIIString() : null;
        } catch (Exception e) {
            return null;
        }
    }
}
