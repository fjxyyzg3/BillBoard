package com.billboard.app;

import static org.junit.Assert.*;

import org.junit.Test;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

public class HouseholdKeyStoreTest {
    static final String ORIGIN = "https://ledger.example.com";
    static final HouseholdKeyStore.Identity IDENTITY = new HouseholdKeyStore.Identity("account-1", "household-1", "member-1");

    static final class Storage implements HouseholdKeyStore.Storage {
        final Map<String, String> values = new HashMap<>();
        boolean writable = true;
        @Override public String read(String slot) { return values.get(slot); }
        @Override public boolean write(String slot, String ciphertext) {
            if (!writable) return false;
            values.put(slot, ciphertext);
            return true;
        }
        @Override public boolean remove(String slot) {
            if (!writable) return false;
            values.remove(slot);
            return true;
        }
    }

    static final class Keys implements HouseholdKeyStore.Keys {
        final Map<String, SecretKey> values = new HashMap<>();
        @Override public SecretKey get(String slot, boolean create) throws GeneralSecurityException {
            if (!values.containsKey(slot) && create) {
                KeyGenerator generator = KeyGenerator.getInstance("AES");
                generator.init(256);
                values.put(slot, generator.generateKey());
            }
            return values.get(slot);
        }
        @Override public void remove(String slot) { values.remove(slot); }
    }

    static String code(String householdId) {
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        String json = "{\"generation\":\"cycle-1\",\"householdId\":" + JSONObject.quote(householdId)
                + ",\"keyVersion\":1,\"secret\":" + JSONObject.quote(Base64.getUrlEncoder().withoutPadding().encodeToString(secret)) + ",\"v\":1}";
        return "BBK1." + Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    @Test public void persistedCiphertextSurvivesStoreRecreationWithoutContainingTheCode() throws Exception {
        Storage storage = new Storage();
        Keys keys = new Keys();
        String code = code("household-1");
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, keys);
        store.store(IDENTITY, code);
        assertEquals(1, storage.values.size());
        String first = storage.values.values().iterator().next();
        assertFalse(first.contains(code));
        assertEquals(code, new HouseholdKeyStore(ORIGIN, storage, keys).load(IDENTITY));
        store.store(IDENTITY, code);
        assertNotEquals(first, storage.values.values().iterator().next());
    }

    @Test public void accountFamilyAndMemberCannotReadAnotherIdentitySlot() throws Exception {
        Storage storage = new Storage();
        Keys keys = new Keys();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, keys);
        store.store(IDENTITY, code("household-1"));
        assertNull(store.load(new HouseholdKeyStore.Identity("account-2", "household-1", "member-1")));
        assertNull(store.load(new HouseholdKeyStore.Identity("account-1", "household-2", "member-1")));
        assertNull(store.load(new HouseholdKeyStore.Identity("account-1", "household-1", "member-2")));
        assertNull(new HouseholdKeyStore("https://another.example.com", storage, keys).load(IDENTITY));
    }

    @Test public void copiedCiphertextFailsEvenIfAnAttackerAlsoSubstitutesTheWrappingKey() throws Exception {
        Storage storage = new Storage();
        Keys keys = new Keys();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, keys);
        store.store(IDENTITY, code("household-1"));
        String firstSlot = storage.values.keySet().iterator().next();
        HouseholdKeyStore.Identity second = new HouseholdKeyStore.Identity("account-2", "household-1", "member-2");
        store.store(second, code("household-1"));
        String secondSlot = storage.values.keySet().stream().filter(slot -> !slot.equals(firstSlot)).findFirst().get();
        storage.values.put(secondSlot, storage.values.get(firstSlot));
        keys.values.put(secondSlot, keys.values.get(firstSlot));
        assertThrows(GeneralSecurityException.class, () -> store.load(second));
    }

    @Test public void logoutDeletesOnlyTheOriginalIdentityKeyAndCiphertext() throws Exception {
        Storage storage = new Storage();
        Keys keys = new Keys();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, keys);
        String originalCode = code("household-1");
        store.store(IDENTITY, originalCode);
        String firstSlot = storage.values.keySet().iterator().next();
        String originalCiphertext = storage.values.get(firstSlot);
        HouseholdKeyStore.Identity second = new HouseholdKeyStore.Identity("account-2", "household-1", "member-2");
        String secondCode = code("household-1");
        store.store(second, secondCode);
        store.clear(IDENTITY);
        assertNull(store.load(IDENTITY));
        assertFalse(keys.values.containsKey(firstSlot));
        assertEquals(secondCode, store.load(second));
        storage.values.put(firstSlot, originalCiphertext);
        assertThrows(GeneralSecurityException.class, () -> store.load(IDENTITY));
    }

    @Test public void tamperedCiphertextAndUnavailableDeviceKeysFailClosed() throws Exception {
        Storage storage = new Storage();
        Keys keys = new Keys();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, keys);
        store.store(IDENTITY, code("household-1"));
        String slot = storage.values.keySet().iterator().next();
        String sealed = storage.values.get(slot);
        String[] parts = sealed.split("\\.");
        byte[] ciphertext = Base64.getUrlDecoder().decode(parts[2]);
        ciphertext[ciphertext.length - 1] ^= 1;
        storage.values.put(slot, parts[0] + "." + parts[1] + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(ciphertext));
        assertThrows(GeneralSecurityException.class, () -> store.load(IDENTITY));
        storage.values.put(slot, sealed);
        keys.values.clear();
        assertThrows(GeneralSecurityException.class, () -> store.load(IDENTITY));
        assertTrue(keys.values.isEmpty());
        assertEquals(sealed, storage.values.get(slot));
    }

    @Test public void invalidAndCrossFamilyCodesCannotBeSaved() throws Exception {
        Storage storage = new Storage();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, new Keys());
        for (String invalid : new String[] {"short-password", "BBK2.invalid", code("household-2"), "BBK1." + "A".repeat(8192)}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> store.store(IDENTITY, invalid));
            assertEquals("Invalid household key request", error.getMessage());
        }
        assertTrue(storage.values.isEmpty());
        assertThrows(IllegalArgumentException.class, () -> new HouseholdKeyStore.Identity("account|other", "household-1", "member-1"));
    }

    @Test public void failedPersistenceDoesNotClaimThatTheCodeWasBackedUp() throws Exception {
        Storage storage = new Storage();
        HouseholdKeyStore store = new HouseholdKeyStore(ORIGIN, storage, new Keys());
        storage.writable = false;
        assertThrows(GeneralSecurityException.class, () -> store.store(IDENTITY, code("household-1")));
        assertNull(store.load(IDENTITY));
    }
}
