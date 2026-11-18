package com.billboard.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Private, identity-bound code storage. Keystore keys never leave the provider. */
final class HouseholdKeyStore {
    static final int MAX_CODE_LENGTH = 4096;
    private static final String ALIAS_PREFIX = "billboard.household-code.v1.";
    private final String origin;
    private final Storage storage;
    private final Keys keys;

    interface Storage {
        String read(String slot);
        boolean write(String slot, String ciphertext);
        boolean remove(String slot);
    }

    interface Keys {
        SecretKey get(String slot, boolean create) throws GeneralSecurityException;
        void remove(String slot) throws GeneralSecurityException;
    }

    static final class Identity {
        final String accountId;
        final String householdId;
        final String memberId;

        Identity(String accountId, String householdId, String memberId) {
            this.accountId = identifier(accountId);
            this.householdId = identifier(householdId);
            this.memberId = identifier(memberId);
        }

        static Identity parse(JSONObject input) {
            try {
                fields(input, "accountId", "householdId", "memberId");
                return new Identity(string(input, "accountId"), string(input, "householdId"), string(input, "memberId"));
            } catch (Exception ignored) {
                throw invalid();
            }
        }

        String binding(String origin) {
            return "BillBoardHouseholdCode.v1|" + origin + "|" + accountId + "|" + householdId + "|" + memberId;
        }
    }

    HouseholdKeyStore(Context context, String origin) {
        this(origin, new Preferences(context.getApplicationContext()), new DeviceKeys());
    }

    HouseholdKeyStore(String origin, Storage storage, Keys keys) {
        new OriginPolicy(origin);
        this.origin = origin;
        this.storage = storage;
        this.keys = keys;
    }

    synchronized void store(Identity identity, String code) throws GeneralSecurityException {
        validateCode(identity, code);
        String slot = slot(identity);
        byte[] plaintext = code.getBytes(StandardCharsets.UTF_8);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keys.get(slot, true));
            cipher.updateAAD(identity.binding(origin).getBytes(StandardCharsets.UTF_8));
            byte[] nonce = cipher.getIV();
            if (nonce == null || nonce.length != 12) throw unavailable();
            String sealed = "v1." + encode(nonce) + "." + encode(cipher.doFinal(plaintext));
            if (!storage.write(slot, sealed)) throw unavailable();
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized String load(Identity identity) throws GeneralSecurityException {
        String slot = slot(identity);
        String sealed = storage.read(slot);
        if (sealed == null) return null;
        if (sealed.length() > MAX_CODE_LENGTH * 2) throw unavailable();
        String[] parts = sealed.split("\\.", -1);
        if (parts.length != 3 || !parts[0].equals("v1")) throw unavailable();
        byte[] nonce = decode(parts[1], 12, 12);
        byte[] ciphertext = decode(parts[2], MAX_CODE_LENGTH + 16, -1);
        if (ciphertext.length < 16) throw unavailable();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        SecretKey key = keys.get(slot, false);
        if (key == null) throw unavailable();
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, nonce));
        cipher.updateAAD(identity.binding(origin).getBytes(StandardCharsets.UTF_8));
        byte[] plaintext = cipher.doFinal(ciphertext);
        try {
            String code = new String(plaintext, StandardCharsets.UTF_8);
            validateCode(identity, code);
            return code;
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized void clear(Identity identity) throws GeneralSecurityException {
        String slot = slot(identity);
        // Removing the per-identity key also makes stale ciphertext copies unusable.
        keys.remove(slot);
        if (!storage.remove(slot)) throw unavailable();
    }

    private String slot(Identity identity) throws GeneralSecurityException {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.binding(origin).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }

    static void validateCode(Identity identity, String code) {
        byte[] bytes = null;
        byte[] secret = null;
        try {
            if (code == null || code.length() > MAX_CODE_LENGTH || !code.startsWith("BBK1.")) throw invalid();
            bytes = decode(code.substring(5), 2048, -1);
            String json = new String(bytes, StandardCharsets.UTF_8);
            JSONObject input = new JSONObject(json);
            fields(input, "v", "householdId", "generation", "keyVersion", "secret");
            if (!(input.get("v") instanceof Number) || input.getInt("v") != 1) throw invalid();
            String householdId = identifier(string(input, "householdId"));
            String generation = identifier(string(input, "generation"));
            if (!householdId.equals(identity.householdId) || !(input.get("keyVersion") instanceof Number)) throw invalid();
            long version = input.getLong("keyVersion");
            if (version < 1 || version > 9007199254740991L || input.getDouble("keyVersion") != version) throw invalid();
            String encodedSecret = string(input, "secret");
            secret = decode(encodedSecret, 32, 32);
            boolean repeated = true;
            for (byte value : secret) if (value != secret[0]) repeated = false;
            if (repeated) throw invalid();
            String canonical = "{\"generation\":" + JSONObject.quote(generation) + ",\"householdId\":" + JSONObject.quote(householdId)
                    + ",\"keyVersion\":" + version + ",\"secret\":" + JSONObject.quote(encodedSecret) + ",\"v\":1}";
            if (!canonical.equals(json)) throw invalid();
        } catch (Exception ignored) {
            throw invalid();
        } finally {
            if (bytes != null) Arrays.fill(bytes, (byte) 0);
            if (secret != null) Arrays.fill(secret, (byte) 0);
        }
    }

    static String identifier(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")) throw invalid();
        return value;
    }

    static String string(JSONObject value, String key) throws org.json.JSONException {
        Object item = value.get(key);
        if (!(item instanceof String)) throw invalid();
        return (String) item;
    }

    static void fields(JSONObject value, String... fields) {
        if (value == null || value.length() != fields.length) throw invalid();
        for (String field : fields) if (!value.has(field)) throw invalid();
    }

    private static String encode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] decode(String value, int maxBytes, int exactBytes) throws GeneralSecurityException {
        if (value == null || value.isEmpty() || value.length() > (maxBytes * 4L + 2) / 3
                || !value.matches("[A-Za-z0-9_-]+")) throw unavailable();
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(value);
            if (bytes.length > maxBytes || (exactBytes >= 0 && bytes.length != exactBytes) || !encode(bytes).equals(value)) {
                Arrays.fill(bytes, (byte) 0);
                throw unavailable();
            }
            return bytes;
        } catch (IllegalArgumentException ignored) {
            throw unavailable();
        }
    }

    static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid household key request"); }
    private static GeneralSecurityException unavailable() { return new GeneralSecurityException("Household key storage unavailable"); }

    private static final class Preferences implements Storage {
        private final SharedPreferences preferences;
        Preferences(Context context) {
            preferences = context.getSharedPreferences("household-codes-v1", Context.MODE_PRIVATE);
        }
        @Override public String read(String slot) { return preferences.getString(slot, null); }
        @Override public boolean write(String slot, String ciphertext) { return preferences.edit().putString(slot, ciphertext).commit(); }
        @Override public boolean remove(String slot) { return preferences.edit().remove(slot).commit(); }
    }

    private static final class DeviceKeys implements Keys {
        private KeyStore provider() throws GeneralSecurityException {
            try {
                KeyStore store = KeyStore.getInstance("AndroidKeyStore");
                store.load(null);
                return store;
            } catch (Exception ignored) { throw unavailable(); }
        }
        @Override public SecretKey get(String slot, boolean create) throws GeneralSecurityException {
            KeyStore store = provider();
            String alias = ALIAS_PREFIX + slot;
            if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
            if (!create) return null;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
            return generator.generateKey();
        }
        @Override public void remove(String slot) throws GeneralSecurityException { provider().deleteEntry(ALIAS_PREFIX + slot); }
    }
}
