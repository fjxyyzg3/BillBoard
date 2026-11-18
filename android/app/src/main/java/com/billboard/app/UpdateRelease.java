package com.billboard.app;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** The server may describe a release, but never chooses its URL or installation identity. */
final class UpdateRelease {
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    static final int MAX_MANIFEST_BYTES = 32 * 1024;
    final String versionName;
    final long versionCode;
    final long size;
    final String sha256;
    final int minSdk;
    final String chineseNotes;
    final String englishNotes;

    private UpdateRelease(JSONObject object) throws JSONException {
        if (object.length() != 6) throw new JSONException("Invalid release fields");
        versionName = string(object, "versionName", 100);
        versionCode = integer(object, "versionCode", 2100000000L);
        size = integer(object, "size", MAX_APK_BYTES);
        sha256 = string(object, "sha256", 64);
        if (!sha256.matches("[0-9a-f]{64}")) throw new JSONException("Invalid digest");
        minSdk = (int) integer(object, "minSdk", 10000);
        Object notesValue = object.get("notes");
        if (!(notesValue instanceof JSONObject)) throw new JSONException("Invalid notes");
        JSONObject notes = (JSONObject) notesValue;
        if (notes.length() != 2) throw new JSONException("Invalid notes fields");
        chineseNotes = string(notes, "zh-CN", 4000);
        englishNotes = string(notes, "en-US", 4000);
    }

    static UpdateRelease parse(String text) throws JSONException {
        return new UpdateRelease(object(text));
    }

    static String command(String text) throws JSONException {
        if (text == null || text.length() > 128) throw new JSONException("Invalid command");
        JSONObject object = object(text);
        if (object.length() != 1) throw new JSONException("Invalid command fields");
        String command = string(object, "command", 8);
        if (!command.matches("status|check|download|install|cancel")) throw new JSONException("Invalid command");
        return command;
    }

    JSONObject json() throws JSONException {
        return new JSONObject().put("versionName", versionName).put("versionCode", versionCode)
                .put("size", size).put("sha256", sha256).put("minSdk", minSdk)
                .put("notes", new JSONObject().put("zh-CN", chineseNotes).put("en-US", englishNotes));
    }

    private static JSONObject object(String text) throws JSONException {
        JSONTokener tokener = new JSONTokener(text);
        Object value = tokener.nextValue();
        if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw new JSONException("Invalid object");
        return (JSONObject) value;
    }

    private static String string(JSONObject object, String key, int max) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > max)
            throw new JSONException("Invalid string");
        String string = (String) value;
        if (key.equals("versionName") && string.matches("(?s).*[\\p{Cntrl}].*"))
            throw new JSONException("Invalid version");
        return string;
    }

    private static long integer(JSONObject object, String key, long max) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new JSONException("Invalid integer");
        long number = ((Number) value).longValue();
        if (number <= 0 || number > max) throw new JSONException("Invalid bounds");
        return number;
    }
}
