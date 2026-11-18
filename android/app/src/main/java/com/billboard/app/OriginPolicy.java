package com.billboard.app;

import java.net.URI;
import java.net.URISyntaxException;

final class OriginPolicy {
    private final URI origin;

    OriginPolicy(String configuredOrigin) {
        origin = parseHttps(configuredOrigin);
        if (origin == null || (origin.getRawPath() != null && !origin.getRawPath().isEmpty()
                && !origin.getRawPath().equals("/")) || origin.getRawQuery() != null || origin.getRawFragment() != null) {
            throw new IllegalArgumentException("The app origin must be an HTTPS root origin.");
        }
    }

    boolean isTrusted(String url) {
        URI target = parseHttps(url);
        return target != null && origin.getHost().equalsIgnoreCase(target.getHost())
                && effectivePort(origin) == effectivePort(target);
    }

    boolean isExternalHttps(String url) {
        return parseHttps(url) != null && !isTrusted(url);
    }

    boolean isRootPage(String url) {
        if (!isTrusted(url)) return false;
        String path = parseHttps(url).getPath();
        return path.isEmpty() || path.equals("/") || path.equals("/home") || path.equals("/login");
    }

    static boolean isSelectedContentUri(String url) {
        URI parsed = parse(url);
        return parsed != null && "content".equals(parsed.getScheme())
                && parsed.getRawAuthority() != null
                && parsed.getRawAuthority().matches("[A-Za-z0-9._-]+") && parsed.getRawUserInfo() == null;
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() == -1 ? 443 : uri.getPort();
    }

    private static URI parseHttps(String url) {
        URI parsed = parse(url);
        return parsed != null && "https".equalsIgnoreCase(parsed.getScheme())
                && parsed.getHost() != null && parsed.getRawUserInfo() == null
                && parsed.getPort() != 0 && parsed.getPort() <= 65535 ? parsed : null;
    }

    private static URI parse(String url) {
        if (url == null || url.isEmpty() || url.indexOf('\\') >= 0) return null;
        for (int index = 0; index < url.length(); index++) {
            if (url.charAt(index) <= 32 || url.charAt(index) == 127) return null;
        }
        try {
            URI parsed = new URI(url);
            return parsed.isAbsolute() && !parsed.isOpaque() ? parsed : null;
        } catch (URISyntaxException exception) {
            return null;
        }
    }
}
