package local.linx.android;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.security.*;
import java.util.*;
import local.linx.android.core.*;
import org.json.*;

/** No third-party test runtime; runs the real Activity, Service, content URIs and network. */
public final class SmokeInstrumentation extends Instrumentation {
  private Bundle args;
  private MainActivity activity;
  private int control, desktop;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    args = arguments;
    start();
  }

  interface Check {
    boolean ok() throws Exception;
  }

  private void waitFor(Check check) throws Exception {
    long start = System.currentTimeMillis();
    while (System.currentTimeMillis() - start < 30000) {
      if (check.ok()) return;
      Thread.sleep(100);
    }
    throw new IOException("Android UI 等待超时");
  }

  private void require(boolean value, String message) throws Exception {
    if (!value) throw new IOException(message);
  }

  private JSONObject control(String route, JSONObject body) throws Exception {
    return Wire.request("127.0.0.1", control, "", route, body, "POST");
  }

  private View find(View view, String text) {
    if (view instanceof TextView && ((TextView) view).getText().toString().equals(text))
      return view;
    if (view instanceof android.view.ViewGroup) {
      android.view.ViewGroup group = (android.view.ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        View match = find(group.getChildAt(i), text);
        if (match != null) return match;
      }
    }
    return null;
  }

  private void click(String label) throws Exception {
    waitFor(
        () -> {
          final boolean[] found = {false};
          runOnMainSync(
              () -> {
                View v = find(activity.getWindow().getDecorView(), label);
                if (v != null) {
                  v.performClick();
                  found[0] = true;
                }
              });
          return found[0];
        });
  }

  private String hash(File file) throws Exception {
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(file)) {
      byte[] b = new byte[65536];
      for (int n; (n = in.read(b)) != -1; ) hash.update(b, 0, n);
    }
    StringBuilder s = new StringBuilder();
    for (byte b : hash.digest()) s.append(String.format(Locale.ROOT, "%02x", b & 255));
    return s.toString();
  }

  private void requireUnchecked(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    try {
      control = Integer.parseInt(args.getString("control_port"));
      desktop = Integer.parseInt(args.getString("desktop_port"));
      activity =
          (MainActivity)
              startActivitySync(
                  new Intent(getTargetContext(), MainActivity.class)
                      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      waitFor(() -> TransferService.current != null && TransferService.current.engine != null);
      TransferService service = TransferService.current;
      LanEngine engine = service.engine;
      control("/ready", Wire.object("port", engine.port, "id", engine.id));
      engine.connect("127.0.0.1", desktop);
      waitFor(() -> engine.snapshot().getJSONArray("peers").length() > 0);
      Thread.sleep(700);
      runOnMainSync(
          () -> {
            View label = find(activity.getWindow().getDecorView(), "电脑端联调终端");
            if (label != null) ((View) label.getParent().getParent().getParent()).performClick();
          });
      File image = new File(engine.received, "微信分享原图.jpg"),
          empty = new File(engine.received, "空文件.txt");
      Bitmap bitmap = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888);
      bitmap.eraseColor(Color.rgb(51, 112, 255));
      try (OutputStream out = new FileOutputStream(image)) {
        bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out);
      }
      bitmap.recycle();
      new FileOutputStream(empty).close();
      Intent share = new Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/jpeg");
      ArrayList<Uri> uris = new ArrayList<>();
      uris.add(ReceivedFileProvider.uri(getTargetContext(), image));
      uris.add(ReceivedFileProvider.uri(getTargetContext(), empty));
      share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
      share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      ClipData clips = ClipData.newRawUri("原图", uris.get(0));
      clips.addItem(new ClipData.Item(uris.get(1)));
      share.setClipData(clips);
      android.content.pm.PackageManager pm = getTargetContext().getPackageManager();
      boolean registered = false;
      for (android.content.pm.ResolveInfo r :
          pm.queryIntentActivities(new Intent(Intent.ACTION_SEND).setType("image/jpeg"), 0))
        if (r.activityInfo.packageName.equals("local.linx.android")) registered = true;
      require(registered, "系统分享入口未注册");
      runOnMainSync(() -> activity.onNewIntent(share));
      waitFor(() -> service.queue.size() == 2 && !service.importing);
      require(hash(service.queue.get(0)).equals(hash(image)), "导入改变了原图");
      Intent repeated =
          new Intent(Intent.ACTION_SEND)
              .setType("image/jpeg")
              .putExtra(Intent.EXTRA_STREAM, uris.get(0))
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      runOnMainSync(() -> activity.onNewIntent(repeated));
      waitFor(() -> service.queue.size() == 3 && !service.importing);
      require(
          !service.queue.get(0).getName().equals(service.queue.get(2).getName()),
          "多次分享的同名文件应自动重命名");
      click("发送 3 项");
      waitFor(
          () -> {
            JSONArray list = engine.snapshot().getJSONArray("transfers");
            for (int i = 0; i < list.length(); i++) {
              JSONObject t = list.getJSONObject(i);
              if (t.optString("direction").equals("outgoing")) {
                if (t.optString("status").equals("failed"))
                  throw new IOException(t.optString("error"));
                if (t.optString("status").equals("completed")) return true;
              }
            }
            return false;
          });
      control("/outgoing-complete", Wire.object("imageHash", hash(image)));
      image.delete();
      empty.delete();
      control("/send-to-phone", Wire.object());
      waitFor(
          () -> {
            JSONArray list = engine.snapshot().getJSONArray("transfers");
            for (int i = 0; i < list.length(); i++)
              if (list.getJSONObject(i).optString("status").equals("pending")) return true;
            return false;
          });
      click("接收文件");
      waitFor(
          () -> {
            JSONArray list = engine.snapshot().getJSONArray("transfers");
            for (int i = 0; i < list.length(); i++) {
              JSONObject t = list.getJSONObject(i);
              if (t.optString("direction").equals("incoming")
                  && t.optString("status").equals("completed")) return true;
              if (t.optString("status").equals("failed"))
                throw new IOException(t.optString("error"));
            }
            return false;
          });
      List<File> received = engine.allReceivedFiles();
      File incoming = null;
      for (File file : received) if (file.getName().equals("电脑发来的图片.png")) incoming = file;
      require(incoming != null, "未保存电脑文件");
      Uri receivedUri = ReceivedFileProvider.uri(getTargetContext(), incoming);
      try (InputStream in = getTargetContext().getContentResolver().openInputStream(receivedUri)) {
        require(in != null && in.read() != -1, "文件打开失败");
      }
      boolean readOnly = false;
      try {
        getTargetContext().getContentResolver().openFileDescriptor(receivedUri, "w").close();
      } catch (FileNotFoundException e) {
        readOnly = true;
      }
      require(readOnly, "接收文件 Provider 应为只读");
      control("/incoming-complete", Wire.object("imageHash", hash(incoming)));
      getUiAutomation().executeShellCommand("input keyevent KEYCODE_HOME").close();
      control("/background-message", Wire.object());
      waitFor(() -> engine.snapshot().getJSONArray("messages").toString().contains("后台仍可接收消息"));
      runOnMainSync(
          () ->
              activity.startActivity(
                  new Intent(activity, MainActivity.class)
                      .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
      Thread.sleep(700);
      control("/capture-transfers", Wire.object());
      click("已接收");
      Thread.sleep(500);
      control("/capture-files", Wire.object());
      // Return a writable content URI, as Android's document picker does.
      java.lang.reflect.Field field = MainActivity.class.getDeclaredField("exportFile");
      field.setAccessible(true);
      field.set(activity, incoming);
      Uri destination = Uri.parse("content://local.linx.android.test.documents/export");
      Intent documentResult = new Intent().setData(destination);
      runOnMainSync(() -> activity.onActivityResult(13, Activity.RESULT_OK, documentResult));
      final long expected = incoming.length();
      waitFor(
          () -> {
            try (android.os.ParcelFileDescriptor fd =
                getTargetContext().getContentResolver().openFileDescriptor(destination, "r")) {
              return fd != null && fd.getStatSize() == expected;
            } catch (Exception e) {
              return false;
            }
          });
      require(incoming.exists(), "另存不应删除原文件");
      // Exercise the real EditText paste menu and keyboard rich-content connection.
      java.lang.reflect.Field messageField = MainActivity.class.getDeclaredField("message");
      messageField.setAccessible(true);
      EditText editor = (EditText) messageField.get(activity);
      final boolean[] accepted = {false};
      runOnMainSync(() -> {
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newUri(activity.getContentResolver(), "图片", receivedUri));
        accepted[0] = editor.onTextContextMenuItem(android.R.id.paste);
      });
      require(accepted[0], "图片粘贴菜单未处理");
      waitFor(() -> service.queue.size() == 1 && !service.importing);
      require(hash(service.queue.get(0)).equals(hash(incoming)), "粘贴图片字节改变");
      service.clearQueue();
      runOnMainSync(() -> {
        android.view.inputmethod.EditorInfo info = new android.view.inputmethod.EditorInfo();
        android.view.inputmethod.InputConnection connection = editor.onCreateInputConnection(info);
        requireUnchecked(info.contentMimeTypes != null && Arrays.asList(info.contentMimeTypes).contains("image/*"), "输入法未声明图片类型");
        accepted[0] = connection.commitContent(new android.view.inputmethod.InputContentInfo(receivedUri,
            new ClipDescription("键盘图片", new String[] {"image/png"}), null), 0, null);
      });
      require(accepted[0], "输入法图片未处理");
      waitFor(() -> service.queue.size() == 1 && !service.importing);
      require(hash(service.queue.get(0)).equals(hash(incoming)), "输入法图片字节改变");
      click("发送 1 项");
      waitFor(() -> engine.snapshot().getJSONArray("transfers").toString().contains("电脑发来的图片.png"));
      waitFor(() -> {
        JSONArray transfers = engine.snapshot().getJSONArray("transfers");
        for (int i=0;i<transfers.length();i++) { JSONObject transfer=transfers.getJSONObject(i);
          if (transfer.optString("direction").equals("outgoing") && transfer.optString("name").equals("电脑发来的图片.png") && transfer.optString("status").equals("completed")) return true;
        }
        return false;
      });
      control("/clipboard-complete", Wire.object("imageHash", hash(incoming)));
      result.putString(
          "stream",
          "Android 15 模拟器系统测试通过：分享入口、content URI 多文件导入、原图不压缩、界面发送/接收、后台消息、只读分享文件、另存为、文件列表、图片粘贴和输入法图片发送。");
      finish(Activity.RESULT_OK, result);
    } catch (Throwable e) {
      result.putString("stream", android.util.Log.getStackTraceString(e));
      finish(Activity.RESULT_CANCELED, result);
    }
  }
}
