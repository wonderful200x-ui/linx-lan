package local.linx.android;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.*;
import java.io.*;
import java.util.*;

/** Shared URIs are copied while their grant is valid, never treated as filesystem paths. */
final class SourceImporter {
  interface Progress {
    void update(String name, long bytes);
  }

  private final ContentResolver resolver;
  private final File root;
  private final Progress progress;
  private int count;
  private final Set<String> existingNames = new HashSet<>();

  SourceImporter(Context context, File root, Collection<File> queued, Progress progress) {
    resolver = context.getContentResolver();
    this.root = root;
    this.progress = progress;
    for (File file : queued) existingNames.add(file.getName().toLowerCase(Locale.ROOT));
  }

  List<File> importUris(List<Uri> uris, boolean tree) throws Exception {
    if (uris.size() > 10000) throw new IOException("每批最多10,000项");
    File batch = new File(root, UUID.randomUUID().toString());
    if (!batch.mkdirs()) throw new IOException("无法创建暂存目录");
    List<File> result = new ArrayList<>();
    Set<String> names = new HashSet<>(existingNames);
    try {
      for (Uri uri : uris) {
        if (!"content".equals(uri.getScheme())) throw new IOException("仅接受系统授权的内容 URI");
        if (tree) {
          String document = DocumentsContract.getTreeDocumentId(uri);
          Uri doc = DocumentsContract.buildDocumentUriUsingTree(uri, document);
          result.add(copyDocument(doc, uri, batch, names));
        } else {
          String name = displayName(uri);
          File file = new File(batch, unique(clean(name), names));
          copy(uri, file);
          result.add(file);
        }
      }
      return result;
    } catch (Exception e) {
      delete(batch);
      throw e;
    }
  }

  private File copyDocument(Uri document, Uri tree, File parent, Set<String> names)
      throws Exception {
    String id, mime, name;
    try (Cursor cursor =
        resolver.query(
            document,
            new String[] {
              DocumentsContract.Document.COLUMN_DOCUMENT_ID,
              DocumentsContract.Document.COLUMN_MIME_TYPE,
              DocumentsContract.Document.COLUMN_DISPLAY_NAME
            },
            null,
            null,
            null)) {
      if (cursor == null || !cursor.moveToFirst()) throw new IOException("无法读取文件夹");
      id = cursor.getString(0);
      mime = cursor.getString(1);
      name = cursor.getString(2);
    }
    File destination = new File(parent, unique(clean(name), names));
    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
      if (++count > 10000) throw new IOException("文件和目录超过10,000项");
      if (!destination.mkdirs()) throw new IOException("不能创建暂存文件夹");
      Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
      Set<String> childNames = new HashSet<>();
      try (Cursor cursor =
          resolver.query(
              children,
              new String[] {DocumentsContract.Document.COLUMN_DOCUMENT_ID},
              null,
              null,
              null)) {
        if (cursor == null) throw new IOException("无法读取子目录");
        while (cursor.moveToNext())
          copyDocument(
              DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)),
              tree,
              destination,
              childNames);
      }
    } else copy(document, destination);
    return destination;
  }

  private String displayName(Uri uri) {
    try (Cursor cursor =
        resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
    } catch (Exception ignored) {
    }
    return "共享文件-" + System.currentTimeMillis();
  }

  private String clean(String name) {
    if (name == null || name.isEmpty()) name = "共享文件";
    name = name.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_").replaceAll("[. ]+$", "");
    if (name.isEmpty()) name = "共享文件";
    if (name.matches("(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$")) name = "_" + name;
    if (name.length() > 180) name = name.substring(0, 180);
    return name;
  }

  private String unique(String name, Set<String> names) {
    String candidate = name;
    int i = 2;
    while (!names.add(candidate.toLowerCase(Locale.ROOT))) {
      int dot = name.lastIndexOf('.');
      candidate =
          dot > 0
              ? name.substring(0, dot) + " (" + (i++) + ")" + name.substring(dot)
              : name + " (" + (i++) + ")";
    }
    return candidate;
  }

  private void copy(Uri uri, File file) throws Exception {
    if (++count > 10000) throw new IOException("文件和目录超过10,000项");
    long total = 0, last = 0;
    try (InputStream in = resolver.openInputStream(uri);
        OutputStream out = new BufferedOutputStream(new FileOutputStream(file), 65536)) {
      if (in == null) throw new IOException("不能读取共享文件，请重新从微信分享或先保存到相册");
      byte[] bytes = new byte[65536];
      for (int n; (n = in.read(bytes)) != -1; ) {
        if (Thread.currentThread().isInterrupted()) throw new IOException("导入已取消");
        if (total - last > 8 * 1024 * 1024 || total == 0) {
          if (file.getParentFile().getUsableSpace() < n + 4L * 1024 * 1024)
            throw new IOException("手机空间不足，暂存需要与原文件相当的空间");
          progress.update(file.getName(), total);
          last = total;
        }
        out.write(bytes, 0, n);
        total += n;
      }
    }
    progress.update(file.getName(), total);
  }

  static void delete(File file) {
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children != null) for (File child : children) delete(child);
    }
    file.delete();
  }
}
