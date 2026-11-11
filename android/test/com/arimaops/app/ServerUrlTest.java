package com.arimaops.app;

public final class ServerUrlTest {
    public static void main(String[] args) {
        assert "https://hq.example".equals(ServerUrl.origin(" https://HQ.example:443/?token=secret "));
        assert "https://hq.example:7420".equals(ServerUrl.origin("https://hq.example:7420/path"));
        for (String url : new String[]{"http://localhost:7420", "http://127.0.0.1", "http://[::1]:7420"}) {
            assert url.equals(ServerUrl.origin(url)) : url;
        }
        for (String url : new String[]{"http://hq.example", "http://localhost.evil", "https://owner:secret@hq.example", "javascript:alert(1)", "file:///etc/passwd", "https://hq.example:0", "https://hq.example:65536", "https://", "https://hq.example\\@evil.example", "not a url"}) {
            assert ServerUrl.origin(url) == null : url;
        }
        assert ServerUrl.sameOrigin("https://hq.example", "https://hq.example:443/path");
        assert !ServerUrl.sameOrigin("https://hq.example", "https://hq.example.evil/path");
        assert !ServerUrl.sameOrigin("https://hq.example", "https://hq.example:7420/path");
        assert "https://hq.example/?open=agent:nyx".equals(ServerUrl.deepLink("https://hq.example", "/?open=agent:nyx"));
        for (String path : new String[]{"//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/\n"}) {
            assert ServerUrl.deepLink("https://hq.example", path) == null : path;
        }
        assert ServerUrl.deepLink(null, "/") == null;
        assert ServerUrl.deepLink("https://hq.example", null) == null;
        System.out.println("Server URL and deep-link checks passed");
    }
}
