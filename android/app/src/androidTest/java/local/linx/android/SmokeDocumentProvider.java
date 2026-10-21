package local.linx.android;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.*;

/** Emulator-only test fixture. Not included in the delivered application. */
public final class SmokeDocumentProvider extends ContentProvider {
  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    return ParcelFileDescriptor.open(
        new File(getContext().getCacheDir(), "export-test.png"),
        ParcelFileDescriptor.parseMode(mode));
  }

  @Override
  public String getType(Uri uri) {
    return "image/png";
  }

  @Override
  public Cursor query(Uri u, String[] p, String s, String[] a, String o) {
    return null;
  }

  @Override
  public Uri insert(Uri u, ContentValues v) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int update(Uri u, ContentValues v, String s, String[] a) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int delete(Uri u, String s, String[] a) {
    throw new UnsupportedOperationException();
  }
}
