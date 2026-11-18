package com.billboard.app;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateReleaseTest {
    static JSONObject manifest() throws JSONException {
        return new JSONObject().put("versionName", "1.48.0").put("versionCode", 1048000)
                .put("size", 64).put("sha256", "a".repeat(64)).put("minSdk", 29)
                .put("notes", new JSONObject().put("zh-CN", "Update").put("en-US", "Update"));
    }

    @Test public void validManifestRoundTripsWithoutAddingUrlOrPackage() throws Exception {
        UpdateRelease release = UpdateRelease.parse(manifest().toString());
        assertEquals(1048000, release.versionCode);
        assertEquals(manifest().toString(), release.json().toString());
    }

    @Test public void rejectsInvalidBoundsTypesAndDigest() throws Exception {
        Object[][] cases = {{"size", 0}, {"size", UpdateRelease.MAX_APK_BYTES + 1}, {"size", "64"},
                {"versionCode", 2.1}, {"versionCode", 2100000001L}, {"versionCode", -1},
                {"minSdk", true}, {"minSdk", 0}, {"sha256", "A".repeat(64)}, {"sha256", "../apk"},
                {"versionName", "version\nname"}, {"versionName", ""}, {"versionName", "v".repeat(101)},
                {"url", "https://evil.example/file.apk"}};
        for (Object[] test : cases) {
            String input = manifest().put((String) test[0], test[1]).toString();
            assertThrows(input, JSONException.class, () -> UpdateRelease.parse(input));
        }
    }

    @Test public void requiresBothBoundedLocalizedNotesAndNoTrailingJson() throws Exception {
        JSONObject missing = manifest();
        missing.getJSONObject("notes").remove("zh-CN");
        assertThrows(JSONException.class, () -> UpdateRelease.parse(missing.toString()));
        JSONObject tooLong = manifest();
        tooLong.getJSONObject("notes").put("en-US", "x".repeat(4001));
        assertThrows(JSONException.class, () -> UpdateRelease.parse(tooLong.toString()));
        assertThrows(JSONException.class, () -> UpdateRelease.parse(manifest() + "{}"));
    }

    @Test public void acceptsOnlyExactCommandObjects() throws Exception {
        for (String command : new String[] {"status", "check", "download", "install", "cancel"})
            assertEquals(command, UpdateRelease.command("{\"command\":\"" + command + "\"}"));
        for (String input : new String[] {"{}", "[]", "null", "{\"command\":1}",
                "{\"command\":\"install\",\"url\":\"https://evil.example/\"}",
                "{\"command\":\"launch\"}", "{\"command\":\"status\"}{}"})
            assertThrows(input, JSONException.class, () -> UpdateRelease.command(input));
    }
}
