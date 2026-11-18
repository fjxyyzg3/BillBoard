package com.billboard.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class BillFixtureProvider extends ContentProvider {
    static final String CONTENT = "date,amount\n2026-01-01,1.00\n";

    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri uri) { return "text/csv"; }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String sortOrder) {
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[] {"fixture.csv", CONTENT.getBytes(StandardCharsets.UTF_8).length});
        return cursor;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!mode.equals("r")) throw new FileNotFoundException("Read only");
        File fixture = new File(getContext().getCacheDir(), "fixture.csv");
        try (FileOutputStream stream = new FileOutputStream(fixture)) {
            stream.write(CONTENT.getBytes(StandardCharsets.UTF_8));
        } catch (IOException exception) {
            throw new FileNotFoundException("Fixture unavailable");
        }
        return ParcelFileDescriptor.open(fixture, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
}
