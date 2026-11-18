package com.billboard.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class OriginPolicyTest {
    private final OriginPolicy policy = new OriginPolicy("https://ledger.example.com");

    @Test public void trustedNavigationUsesExactHttpsOrigin() {
        assertTrue(policy.isTrusted("https://ledger.example.com/home?range=month#summary"));
        assertTrue(policy.isTrusted("https://LEDGER.example.com:443/records/import"));
        assertFalse(policy.isTrusted("http://ledger.example.com/home"));
        assertFalse(policy.isTrusted("https://ledger.example.com:444/home"));
        assertFalse(policy.isTrusted("https://ledger.example.com.evil.example/home"));
        assertFalse(policy.isTrusted("https://other.example.com/home"));
    }

    @Test public void parserAmbiguitiesAndLocalSchemesFailClosed() {
        String[] urls = {null, "", " https://ledger.example.com", "https://ledger.example.com\\@evil.example",
            "https://ledger.example.com@evil.example", "https://user@ledger.example.com", "https://ledger.example.com\n/home",
            "https://ledger.example.com./home", "https://%6cedger.example.com", "//ledger.example.com/home",
            "javascript:alert(1)", "file:///etc/passwd", "content://provider/item", "intent://ledger.example.com"};
        for (String url : urls) assertFalse(String.valueOf(url), policy.isTrusted(url));
    }

    @Test public void externalLinksMustBeUnambiguousHttps() {
        assertTrue(policy.isExternalHttps("https://docs.example.com/help"));
        assertFalse(policy.isExternalHttps("https://ledger.example.com/home"));
        assertFalse(policy.isExternalHttps("https://user:password@docs.example.com"));
        assertFalse(policy.isExternalHttps("http://docs.example.com"));
        assertFalse(policy.isExternalHttps("mailto:user@example.com"));
    }

    @Test public void homeAndLoginAreRootPagesEvenAfterAuthenticatedRedirects() {
        assertTrue(policy.isRootPage("https://ledger.example.com/home?range=month"));
        assertTrue(policy.isRootPage("https://ledger.example.com/login"));
        assertFalse(policy.isRootPage("https://ledger.example.com/records/import"));
        assertFalse(policy.isRootPage("https://other.example.com/home"));
    }

    @Test public void invalidConfiguredOriginsAreRejected() {
        for (String origin : new String[] {"http://ledger.example.com", "https://ledger.example.com/home",
                "https://ledger.example.com?query=1", "https://ledger.example.com#fragment", "https://user@ledger.example.com"}) {
            assertThrows(IllegalArgumentException.class, () -> new OriginPolicy(origin));
        }
    }

    @Test public void selectedFilesMustRemainContentUris() {
        assertTrue(OriginPolicy.isSelectedContentUri("content://com.android.providers.downloads.documents/document/42"));
        assertTrue(OriginPolicy.isSelectedContentUri("content://com.example.file_provider/document/42"));
        assertFalse(OriginPolicy.isSelectedContentUri("file:///sdcard/bill.csv"));
        assertFalse(OriginPolicy.isSelectedContentUri("https://ledger.example.com/bill.csv"));
        assertFalse(OriginPolicy.isSelectedContentUri("content:///document/42"));
        assertFalse(OriginPolicy.isSelectedContentUri("content://user@provider/document/42"));
    }
}
