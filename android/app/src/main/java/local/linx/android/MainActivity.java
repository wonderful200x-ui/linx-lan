package local.linx.android;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.view.inputmethod.*;
import android.widget.*;
import java.io.*;
import java.util.*;
import local.linx.android.core.LanEngine;
import org.json.*;

public final class MainActivity extends Activity {
  private static final int BLUE = 0xff0099e6, INK = 0xff25282d, MUTED = 0xff7c818a, BG = 0xfff5f5f5;
  private static final int PICK = 11, TREE = 12, SAVE = 13;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private LinearLayout body, root, nav, composer;
  private ScrollView scroll;
  private TextView subtitle;
  private EditText message;
  private String selected = "", tab = "传输";
  private long revision = -1;
  private File exportFile;
  private boolean visible;
  private final Runnable refresh =
      new Runnable() {
        @Override
        public void run() {
          if (!visible) return;
          TransferService s = TransferService.current;
          if (s != null && s.revision.get() != revision) {
            revision = s.revision.get();
            render();
          } else if (s == null) {
            subtitle.setText("服务已停止 · 点击重新启动");
          }
          handler.postDelayed(this, 400);
        }
      };

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    if (saved != null) {
      selected = saved.getString("selected", "");
      tab = saved.getString("tab", "传输");
    }
    getWindow().setStatusBarColor(BG);
    getWindow().setNavigationBarColor(Color.WHITE);
    build();
    startServiceSafely();
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED)
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 20);
    handleShare(getIntent());
  }

  @Override
  public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleShare(intent);
  }

  @Override
  public void onSaveInstanceState(Bundle out) {
    out.putString("selected", selected);
    out.putString("tab", tab);
    super.onSaveInstanceState(out);
  }

  @Override
  public void onResume() {
    super.onResume();
    visible = true;
    handler.post(refresh);
  }

  @Override
  public void onPause() {
    visible = false;
    handler.removeCallbacks(refresh);
    super.onPause();
  }

  private void startServiceSafely() {
    try {
      startForegroundService(new Intent(this, TransferService.class));
    } catch (Exception e) {
      toast("无法启动传输服务：" + e.getMessage());
    }
  }

  private void build() {
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(BG);
    root.setPadding(dp(20), dp(12), dp(20), 0);
    setContentView(root);
    LinearLayout header = row();
    TextView brand = text("飞鼠", 22, INK, true);
    header.addView(brand, new LinearLayout.LayoutParams(0, dp(56), 1));
    header.addView(button("手动连接", false, this::connectDialog));
    header.addView(button("设置", false, this::settings));
    root.addView(header);
    subtitle = text("正在开启局域网发现…", 11, MUTED, false);
    subtitle.setPadding(0, 0, 0, dp(14));
    subtitle.setOnClickListener(v -> startServiceSafely());
    root.addView(subtitle);
    scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);
    body = column();
    body.setPadding(0, 0, 0, dp(12));
    scroll.addView(body);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    composer = row();
    composer.setPadding(0, dp(8), 0, dp(8));
    message = new EditText(this) {
      @Override
      public InputConnection onCreateInputConnection(EditorInfo info) {
        InputConnection original = super.onCreateInputConnection(info);
        if (original == null) return null;
        info.contentMimeTypes = new String[] {"image/*"};
        return new InputConnectionWrapper(original, false) {
          @Override
          public boolean commitContent(InputContentInfo content, int flags, Bundle opts) {
            if (content == null || !content.getDescription().hasMimeType("image/*")) return false;
            try {
              if ((flags & InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) content.requestPermission();
              ArrayList<Uri> uris = new ArrayList<>(); uris.add(content.getContentUri());
              forwardImport(uris, false, null, content);
              showImageQueue();
              return true;
            } catch (Exception e) { content.releasePermission(); toast("不能读取输入法图片：" + e.getMessage()); return false; }
          }
        };
      }
      @Override
      public boolean onTextContextMenuItem(int id) {
        if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
          ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
          ClipData clips = clipboard.getPrimaryClip();
          if (clips != null && clipboard.getPrimaryClipDescription() != null
              && clipboard.getPrimaryClipDescription().hasMimeType("image/*")) {
            ArrayList<Uri> uris = new ArrayList<>();
            for (int i = 0; i < clips.getItemCount(); i++) {
              Uri uri = clips.getItemAt(i).getUri(); if (uri != null) uris.add(uri);
            }
            if (!uris.isEmpty()) { forwardImport(uris, false, null); showImageQueue(); return true; }
          }
        }
        return super.onTextContextMenuItem(id);
      }
    };
    message.setTextSize(14);
    message.setSingleLine(false);
    message.setMaxLines(3);
    message.setHint("输入消息…");
    message.setBackground(shape(Color.WHITE, 4));
    message.setPadding(dp(12), dp(10), dp(12), dp(10));
    composer.addView(message, new LinearLayout.LayoutParams(0, -2, 1));
    composer.addView(
        button(
            "发送",
            true,
            () -> {
              String value = message.getText().toString();
              String peerId = selected;
              run(
                  () -> {
                    engine().sendMessage(peerId, value);
                    runOnUiThread(
                        () -> {
                          if (message.getText().toString().equals(value)) message.setText("");
                        });
                  });
            }));
    root.addView(composer);
    composer.setVisibility(View.GONE);
    nav = row();
    nav.setPadding(0, dp(8), 0, dp(12));
    root.addView(nav);
    renderNav();
  }

  private void renderNav() {
    nav.removeAllViews();
    for (String name : new String[] {"传输", "消息", "已接收"}) {
      Button b =
          button(
              name,
              tab.equals(name),
              () -> {
                tab = name;
                revision = -1;
                renderNav();
                render();
              });
      nav.addView(b, new LinearLayout.LayoutParams(0, dp(44), 1));
    }
  }

  private LanEngine engine() throws IOException {
    TransferService s = TransferService.current;
    if (s == null || s.engine == null) throw new IOException("传输服务尚未准备好，请稍后或点击上方重新启动");
    return s.engine;
  }

  private void render() {
    TransferService s = TransferService.current;
    if (s == null || s.engine == null) {
      subtitle.setText(s == null ? "服务已停止 · 点击重新启动" : s.status);
      return;
    }
    JSONObject state = s.engine.snapshot();
    JSONArray addresses = state.optJSONArray("addresses");
    String address =
        addresses != null && addresses.length() > 0 ? addresses.optString(0) : "未连接 Wi-Fi";
    subtitle.setText(
        state.optString("name")
            + " · "
            + address
            + (address.contains(".") ? ":" + state.optInt("port") : ""));
    int position = scroll.getScrollY();
    body.removeAllViews();
    composer.setVisibility(tab.equals("消息") ? View.VISIBLE : View.GONE);
    if (!state.optString("warning").isEmpty()) {
      TextView warning = text(state.optString("warning"), 12, 0xffa26c2e, false);
      warning.setPadding(dp(12), dp(10), dp(12), dp(10));
      warning.setBackground(shape(0xfffff2d8, 10));
      body.addView(warning);
      space(body, 12);
    }
    if (tab.equals("传输")) {
      renderPeers(state);
      boolean active = s.engine.hasActiveTransfers();
      if (active) renderTransfers(state);
      renderQueue(s);
      if (!active) renderTransfers(state);
    } else if (tab.equals("消息")) {
      renderPeers(state);
      renderMessages(state);
      if (!s.sharedText.isEmpty() && message.getText().length() == 0) {
        message.setText(s.sharedText);
        s.sharedText = "";
      }
    } else renderFiles(s);
    scroll.post(() -> scroll.scrollTo(0, position));
  }

  private void renderPeers(JSONObject state) {
    LinearLayout heading = row();
    heading.addView(text("附近的终端", 16, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
    heading.addView(
        button(
            "刷新",
            false,
            () -> {
              try {
                engine().announce();
                toast("正在发现同一网络的终端");
              } catch (Exception e) {
                toast(e.getMessage());
              }
            }));
    body.addView(heading);
    JSONArray peers = state.optJSONArray("peers");
    if (peers == null || peers.length() == 0) {
      LinearLayout empty = card(0xffeeeeee);
      empty.addView(text("还没有发现终端", 16, INK, true));
      space(empty, 8);
      empty.addView(text("手机和电脑连接同一 Wi-Fi，并打开飞鼠。\n也可以点右上角输入电脑首页的 IP 和端口。", 13, MUTED, false));
      body.addView(empty);
    } else
      for (int i = 0; i < peers.length(); i++) {
        JSONObject p = peers.optJSONObject(i);
        if (p == null) continue;
        String id = p.optString("id");
        boolean online = p.optBoolean("online");
        LinearLayout cell = card(id.equals(selected) ? 0xffdfe7eb : Color.WHITE);
        LinearLayout row = row();
        TextView avatar =
            text(
                p.optString("name", "?")
                    .substring(0, Math.min(1, p.optString("name", "?").length())),
                21,
                BLUE,
                true);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(shape(0xffdceaf1, 5));
        row.addView(avatar, new LinearLayout.LayoutParams(dp(43), dp(43)));
        LinearLayout info = column();
        info.setPadding(dp(12), 0, 0, 0);
        info.addView(text(p.optString("name"), 14, INK, true));
        info.addView(
            text(
                (online ? "● 在线 · " : "离线 · ")
                    + platform(p.optString("platform"))
                    + " · "
                    + p.optString("address"),
                11,
                MUTED,
                false));
        row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(
            text(id.equals(selected) ? "✓" : "选择", 12, id.equals(selected) ? BLUE : MUTED, true));
        cell.addView(row);
        cell.setOnClickListener(
            v -> {
              selected = id;
              revision = -1;
              render();
            });
        body.addView(cell);
      }
  }

  private void renderQueue(TransferService s) {
    space(body, 12);
    LinearLayout card = card(Color.WHITE);
    card.addView(text("发送文件", 16, INK, true));
    space(card, 6);
    card.addView(text("微信「分享/用其他应用打开」→ 飞鼠；\n没有分享入口时，先保存图片，再从这里选择。", 12, MUTED, false));
    space(card, 14);
    LinearLayout buttons = row();
    buttons.addView(
        button("图片 / 视频", false, () -> pick(true)), new LinearLayout.LayoutParams(0, dp(46), 1));
    buttons.addView(
        button("文件", false, () -> pick(false)), new LinearLayout.LayoutParams(0, dp(46), 1));
    buttons.addView(
        button("文件夹", false, this::pickTree), new LinearLayout.LayoutParams(0, dp(46), 1));
    card.addView(buttons);
    space(card, 12);
    if (s.status.startsWith("导入失败")) card.addView(text(s.status, 12, 0xffba5b58, false));
    else if (s.importing && !s.queue.isEmpty()) card.addView(text(s.status, 12, MUTED, false));
    if (s.queue.isEmpty())
      card.addView(text(s.importing ? s.status : "等待分享或选择文件 · 不压缩原文件", 12, MUTED, false));
    else {
      int shown = 0;
      for (File file : s.queue) {
        if (shown++ >= 8) {
          card.addView(text("以及另外 " + (s.queue.size() - 8) + " 项", 12, MUTED, false));
          break;
        }
        TextView item =
            text(
                (file.isDirectory() ? "▣ " : "↗ ")
                    + file.getName()
                    + (file.isFile() ? " · " + formatBytes(file.length()) : ""),
                12,
                INK,
                false);
        item.setPadding(0, dp(5), 0, dp(5));
        card.addView(item);
      }
      LinearLayout actions = row();
      actions.addView(
          button(
              "清空",
              false,
              () -> {
                s.clearQueue();
                render();
              }));
      Button send =
          button(
              s.importing ? "正在导入…" : "发送 " + s.queue.size() + " 项",
              true,
              () -> {
                if (selected.isEmpty()) {
                  toast("先选择一个在线终端");
                  return;
                }
                s.submit(
                    selected,
                    error ->
                        runOnUiThread(
                            () -> {
                              toast(error == null ? "已发送请求，等待电脑接收" : error);
                              revision = -1;
                              render();
                            }));
              });
      send.setEnabled(!s.importing);
      actions.addView(send, new LinearLayout.LayoutParams(0, dp(46), 1));
      card.addView(actions);
    }
    if (!s.sharedText.isEmpty()) {
      space(card, 8);
      card.addView(
          button(
              "发送分享的文字",
              false,
              () -> {
                tab = "消息";
                renderNav();
                render();
              }));
    }
    body.addView(card);
    LinearLayout tip = card(0xffeeeeee);
    tip.addView(text("只在可信局域网使用", 12, 0xff538875, true));
    tip.addView(text("文件直接传输，不经过云端；当前协议为明文。传输时保留通知，可切回微信。", 11, 0xff7f9b90, false));
    body.addView(tip);
  }

  private void renderTransfers(JSONObject state) {
    space(body, 12);
    body.addView(text("传输动态", 16, INK, true));
    space(body, 10);
    JSONArray list = state.optJSONArray("transfers");
    if (list == null || list.length() == 0) {
      body.addView(text("接收确认、速度和进度会显示在这里。", 12, MUTED, false));
      return;
    }
    for (int i = 0; i < list.length(); i++) {
      JSONObject t = list.optJSONObject(i);
      if (t != null) {
        boolean active =
            TransferService.current != null && TransferService.current.engine.hasActiveTransfers();
        if (!active
            || Arrays.asList("pending", "sending", "receiving").contains(t.optString("status")))
          transferCard(t);
      }
    }
  }

  private void transferCard(JSONObject t) {
    String id = t.optString("id"), status = t.optString("status");
    boolean incoming = t.optString("direction").equals("incoming"),
        active = Arrays.asList("pending", "sending", "receiving").contains(status);
    LinearLayout card = card(Color.WHITE);
    card.addView(text(t.optString("name"), 14, INK, true));
    card.addView(
        text(
            (incoming ? "来自 " : "发送给 ")
                + t.optString("peerName")
                + " · "
                + formatBytes(t.optLong("total")),
            11,
            MUTED,
            false));
    ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setMax(1000);
    long total = t.optLong("total"), bytes = t.optLong("bytes");
    progress.setProgress(
        status.equals("completed")
            ? 1000
            : total > 0 ? (int) Math.min(1000, bytes * 1000.0 / total) : 0);
    progress.setProgressTintList(
        android.content.res.ColorStateList.valueOf(status.equals("completed") ? 0xff29b68b : BLUE));
    LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(-1, dp(8));
    pp.setMargins(0, dp(10), 0, dp(7));
    card.addView(progress, pp);
    card.addView(
        text(
            statusName(status)
                + " · "
                + formatBytes(bytes)
                + " / "
                + formatBytes(total)
                + (active && t.optDouble("speed") > 0
                    ? " · " + formatBytes((long) t.optDouble("speed")) + "/s"
                    : ""),
            11,
            BLUE,
            false));
    if (!t.optString("error").isEmpty())
      card.addView(text(t.optString("error"), 12, 0xffba5b58, false));
    LinearLayout actions = row();
    if (incoming && status.equals("pending")) {
      actions.addView(button("拒绝", false, () -> run(() -> engine().accept(id, false))));
      actions.addView(button("接收文件", true, () -> run(() -> engine().accept(id, true))));
    } else if (active) actions.addView(button("取消", false, () -> run(() -> engine().cancel(id))));
    if (incoming && status.equals("completed"))
      actions.addView(
          button(
              "查看文件",
              false,
              () -> {
                tab = "已接收";
                renderNav();
                render();
              }));
    if (!incoming && Arrays.asList("failed", "cancelled", "rejected").contains(status))
      actions.addView(button("重新发送", false, () -> run(() -> engine().retry(id))));
    card.addView(actions);
    body.addView(card);
  }

  private void renderMessages(JSONObject state) {
    if (selected.isEmpty()) {
      body.addView(text("选择终端后即可发送消息。", 13, MUTED, false));
      return;
    }
    JSONArray list = state.optJSONArray("messages");
    int count = 0;
    if (list != null)
      for (int i = 0; i < list.length(); i++) {
        JSONObject m = list.optJSONObject(i);
        if (m == null || !m.optString("peerId").equals(selected)) continue;
        if (++count > 300) continue;
        boolean own = m.optString("direction").equals("outgoing");
        LinearLayout card = card(own ? 0xffe7efff : Color.WHITE);
        card.addView(text(own ? "我" : m.optString("peerName", "对方"), 10, MUTED, false));
        TextView text = text(m.optString("text"), 14, INK, false);
        text.setTextIsSelectable(true);
        card.addView(text);
        body.addView(card);
      }
    if (count == 0) body.addView(text("发一句问候，开始协作。", 13, MUTED, false));
  }

  private void renderFiles(TransferService s) {
    body.addView(text("已接收的文件", 18, INK, true));
    space(body, 6);
    body.addView(text("文件保存在飞鼠应用内。可打开、分享，或另存到手机公共目录；卸载应用会删除未导出的文件。", 12, MUTED, false));
    space(body, 14);
    List<File> files = s.engine.allReceivedFiles();
    files.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
    if (files.isEmpty()) body.addView(text("电脑发来文件后，在传输页点击接收。", 13, MUTED, false));
    int count = 0;
    for (File file : files) {
      if (count++ >= 200) {
        body.addView(text("文件较多，请从电脑按文件夹分批发送。", 12, MUTED, false));
        break;
      }
      LinearLayout card = card(Color.WHITE);
      card.addView(text(file.getName(), 14, INK, true));
      card.addView(
          text(
              formatBytes(file.length()) + " · " + file.getParentFile().getName(),
              11,
              MUTED,
              false));
      LinearLayout actions = row();
      actions.addView(button("打开", false, () -> openFile(file, false)));
      actions.addView(button("分享", false, () -> openFile(file, true)));
      actions.addView(
          button(
              "另存为",
              true,
              () -> {
                exportFile = file;
                Intent intent =
                    new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(mime(file))
                        .putExtra(Intent.EXTRA_TITLE, file.getName());
                startActivityForResult(intent, SAVE);
              }));
      card.addView(actions);
      body.addView(card);
    }
  }

  private void openFile(File file, boolean share) {
    try {
      Uri uri = ReceivedFileProvider.uri(this, file);
      Intent intent = new Intent(share ? Intent.ACTION_SEND : Intent.ACTION_VIEW);
      if (share) {
        intent.setType(mime(file));
        intent.putExtra(Intent.EXTRA_STREAM, uri);
      } else intent.setDataAndType(uri, mime(file));
      intent.setClipData(ClipData.newRawUri("文件", uri));
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      startActivity(Intent.createChooser(intent, share ? "分享文件" : "打开文件"));
    } catch (Exception e) {
      toast("无法打开文件：" + e.getMessage());
    }
  }

  private String mime(File file) {
    try {
      return getContentResolver().getType(ReceivedFileProvider.uri(this, file));
    } catch (Exception e) {
      return "application/octet-stream";
    }
  }

  private void pick(boolean photos) {
    Intent intent =
        new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(photos ? "image/*" : "*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    if (photos) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "video/*"});
    startActivityForResult(intent, PICK);
  }

  private void pickTree() {
    startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), TREE);
  }

  private void handleShare(Intent intent) {
    if (intent == null
        || !(Intent.ACTION_SEND.equals(intent.getAction())
            || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return;
    ArrayList<Uri> uris = new ArrayList<>();
    if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
      ArrayList<Uri> values = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (values != null) uris.addAll(values);
    } else {
      Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (uri != null) uris.add(uri);
    }
    if (uris.isEmpty() && intent.getClipData() != null)
      for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
        Uri uri = intent.getClipData().getItemAt(i).getUri();
        if (uri != null) uris.add(uri);
      }
    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
    forwardImport(uris, false, text);
    intent.setAction(null);
    tab = "传输";
    renderNav();
  }

  private void showImageQueue() {
    tab = "传输"; revision = -1; renderNav(); render();
    toast("图片已加入待发送列表，请确认后发送");
  }

  private void forwardImport(ArrayList<Uri> uris, boolean tree, String text) {
    forwardImport(uris, tree, text, null);
  }

  private void forwardImport(ArrayList<Uri> uris, boolean tree, String text, InputContentInfo content) {
    Intent service =
        new Intent(this, TransferService.class)
            .setAction(TransferService.IMPORT)
            .putParcelableArrayListExtra("uris", uris)
            .putExtra("tree", tree)
            .putExtra("text", text)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    if (content != null) service.putExtra("inputContent", content);
    if (!uris.isEmpty()) {
      ClipData clips = ClipData.newRawUri("飞鼠共享文件", uris.get(0));
      for (int i = 1; i < uris.size(); i++) clips.addItem(new ClipData.Item(uris.get(i)));
      service.setClipData(clips);
    }
    try {
      startForegroundService(service);
    } catch (Exception e) {
      if (content != null) content.releasePermission();
      toast("不能导入文件：" + e.getMessage());
    }
  }

  @Override
  public void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (result != RESULT_OK || data == null) return;
    if (request == SAVE && exportFile != null && data.getData() != null) {
      File source = exportFile;
      Uri dest = data.getData();
      new Thread(
              () -> {
                try (InputStream in = new FileInputStream(source);
                    OutputStream out = getContentResolver().openOutputStream(dest, "w")) {
                  if (out == null) throw new IOException("目标不可写");
                  byte[] bytes = new byte[65536];
                  for (int n; (n = in.read(bytes)) != -1; ) out.write(bytes, 0, n);
                  runOnUiThread(() -> toast("文件已另存"));
                } catch (Exception e) {
                  runOnUiThread(() -> toast("保存失败：" + e.getMessage()));
                }
              },
              "linx-export")
          .start();
      return;
    }
    if (request == PICK || request == TREE) {
      ArrayList<Uri> uris = new ArrayList<>();
      if (data.getClipData() != null)
        for (int i = 0; i < data.getClipData().getItemCount(); i++)
          uris.add(data.getClipData().getItemAt(i).getUri());
      else if (data.getData() != null) uris.add(data.getData());
      forwardImport(uris, request == TREE, null);
      tab = "传输";
      renderNav();
    }
  }

  private void connectDialog() {
    LinearLayout form = column();
    form.setPadding(dp(22), dp(6), dp(22), 0);
    EditText address = input("电脑首页的 IPv4，例如192.168.1.20");
    address.setInputType(android.text.InputType.TYPE_CLASS_PHONE);
    EditText port = input("端口，例如52341");
    port.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
    form.addView(address);
    form.addView(port);
    AlertDialog dialog =
        new AlertDialog.Builder(this)
            .setTitle("手动连接终端")
            .setMessage("手机和电脑需连接可互通的网络。")
            .setView(form)
            .setNegativeButton("取消", null)
            .setPositiveButton("连接", null)
            .create();
    dialog.setOnShowListener(
        d ->
            dialog
                .getButton(-1)
                .setOnClickListener(
                    v ->
                        run(
                            () -> {
                              String id =
                                  engine()
                                      .connect(
                                          address.getText().toString().trim(),
                                          Integer.parseInt(port.getText().toString().trim()));
                              runOnUiThread(
                                  () -> {
                                    selected = id;
                                    dialog.dismiss();
                                    revision = -1;
                                    render();
                                    toast("已连接");
                                  });
                            })));
    dialog.show();
  }

  private void settings() {
    try {
      EditText input = input("终端名称");
      input.setText(engine().name);
      LinearLayout form = column();
      form.setPadding(dp(22), 0, dp(22), 0);
      form.addView(input);
      TextView info =
          text(
              "传输需要保持局域网服务运行。可切回微信，后台通知中可停止服务。部分手机需允许后台运行。\n\n"
                  + "Android 15+ 对数据同步前台服务有后台时限；服务停止后重新打开应用即可。\n\n"
                  + "版本 1.2.0 · 仅用于可信局域网",
              12,
              MUTED,
              false);
      form.addView(info);
      new AlertDialog.Builder(this)
          .setTitle("我的终端")
          .setView(form)
          .setPositiveButton("保存", (d, w) -> run(() -> engine().rename(input.getText().toString())))
          .setNeutralButton(
              "停止服务",
              (d, w) -> {
                stopService(new Intent(this, TransferService.class));
                subtitle.setText("服务已停止 · 点击重新启动");
              })
          .setNegativeButton("取消", null)
          .show();
    } catch (Exception e) {
      toast(e.getMessage());
    }
  }

  interface Task {
    void run() throws Exception;
  }

  private void run(Task task) {
    new Thread(
            () -> {
              try {
                task.run();
                runOnUiThread(
                    () -> {
                      revision = -1;
                      render();
                    });
              } catch (Exception e) {
                runOnUiThread(() -> toast(e.getMessage()));
              }
            },
            "linx-ui-action")
        .start();
  }

  private void toast(String message) {
    Toast.makeText(this, message == null ? "操作失败" : message, Toast.LENGTH_LONG).show();
  }

  private int dp(float value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private LinearLayout column() {
    LinearLayout v = new LinearLayout(this);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  private LinearLayout row() {
    LinearLayout v = new LinearLayout(this);
    v.setOrientation(LinearLayout.HORIZONTAL);
    v.setGravity(Gravity.CENTER_VERTICAL);
    return v;
  }

  private TextView text(String value, int size, int color, boolean bold) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setLineSpacing(dp(3), 1);
    if (bold) v.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    return v;
  }

  private GradientDrawable shape(int color, int radius) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(radius));
    return d;
  }

  private LinearLayout card(int color) {
    LinearLayout v = column();
    v.setPadding(dp(16), dp(14), dp(16), dp(14));
    v.setBackground(shape(color, 5));
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(8), 0, dp(4));
    v.setLayoutParams(p);
    return v;
  }

  private Button button(String value, boolean primary, Runnable action) {
    Button v = new Button(this);
    v.setText(value);
    v.setTextSize(12);
    v.setAllCaps(false);
    v.setTextColor(primary ? Color.WHITE : BLUE);
    v.setMinHeight(0);
    v.setMinimumHeight(0);
    v.setMinWidth(0);
    v.setMinimumWidth(0);
    v.setPadding(dp(12), dp(8), dp(12), dp(8));
    v.setBackground(shape(primary ? BLUE : 0x000099e6, 4));
    v.setOnClickListener(w -> action.run());
    return v;
  }

  private EditText input(String hint) {
    EditText edit = new EditText(this);
    edit.setTextSize(14);
    edit.setSingleLine(true);
    edit.setHint(hint);
    return edit;
  }

  private void space(LinearLayout target, int height) {
    target.addView(new View(this), new LinearLayout.LayoutParams(1, dp(height)));
  }

  public static String formatBytes(long bytes) {
    if (bytes < 1024) return bytes + " B";
    int i = Math.min(4, (int) (Math.log(bytes) / Math.log(1024)));
    return String.format(
        Locale.ROOT,
        "%.1f %s",
        bytes / Math.pow(1024, i),
        new String[] {"B", "KB", "MB", "GB", "TB"}[i]);
  }

  private String platform(String value) {
    return value.equals("darwin")
        ? "Mac"
        : value.equals("win32") ? "Windows" : value.equals("android") ? "Android" : "电脑";
  }

  private String statusName(String s) {
    switch (s) {
      case "pending":
        return "等待接收";
      case "sending":
        return "正在发送";
      case "receiving":
        return "正在接收";
      case "completed":
        return "已完成 · 校验通过";
      case "cancelled":
        return "已取消";
      case "rejected":
        return "已拒绝";
      default:
        return "传输失败";
    }
  }
}
