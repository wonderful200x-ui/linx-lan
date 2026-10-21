package local.linx.android;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.*;
import java.util.*;

/** Read-only content access granted explicitly to the external viewer/sharesheet. */
public final class ReceivedFileProvider extends ContentProvider {
  static final String AUTHORITY = "local.linx.android.files";

  private File root() {
    return new File(getContext().getFilesDir(), "linx/received");
  }

  static Uri uri(Context c, File file) throws IOException {
    File root = new File(c.getFilesDir(), "linx/received").getCanonicalFile();
    String absolute = file.getCanonicalPath();
    if (!absolute.startsWith(root.getPath() + File.separator)) throw new IOException("不允许访问此文件");
    Uri.Builder builder = new Uri.Builder().scheme("content").authority(AUTHORITY);
    for (String part : absolute.substring(root.getPath().length() + 1).split("/"))
      builder.appendPath(part);
    return builder.build();
  }

  private File resolve(Uri uri) throws FileNotFoundException {
    try {
      File root = root().getCanonicalFile();
      File file = new File(root, String.join("/", uri.getPathSegments())).getCanonicalFile();
      if (!file.getPath().startsWith(root.getPath() + File.separator)
          || !file.isFile()
          || file.getName().startsWith(".linx-")) throw new IOException("文件不可用");
      return file;
    } catch (IOException e) {
      throw new FileNotFoundException(e.getMessage());
    }
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public String getType(Uri uri) {
    try {
      String name = resolve(uri).getName();
      int i = name.lastIndexOf('.');
      String mime =
          i < 0
              ? null
              : MimeTypeMap.getSingleton()
                  .getMimeTypeFromExtension(name.substring(i + 1).toLowerCase(Locale.ROOT));
      return mime == null ? "application/octet-stream" : mime;
    } catch (Exception e) {
      return "application/octet-stream";
    }
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("只允许读取");
    return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
    try {
      File file = resolve(uri);
      String[] columns =
          projection == null
              ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}
              : projection;
      MatrixCursor result = new MatrixCursor(columns);
      Object[] row = new Object[columns.length];
      for (int i = 0; i < columns.length; i++)
        row[i] =
            OpenableColumns.DISPLAY_NAME.equals(columns[i])
                ? file.getName()
                : OpenableColumns.SIZE.equals(columns[i]) ? file.length() : null;
      result.addRow(row);
      return result;
    } catch (Exception e) {
      return null;
    }
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] args) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int delete(Uri uri, String selection, String[] args) {
    throw new UnsupportedOperationException();
  }
}
