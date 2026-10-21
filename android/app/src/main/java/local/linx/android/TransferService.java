package local.linx.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import local.linx.android.core.LanEngine;

public final class TransferService extends Service {
  public static volatile TransferService current;
  public volatile LanEngine engine;
  public final AtomicLong revision = new AtomicLong();
  public final List<File> queue = new CopyOnWriteArrayList<>();
  public volatile String status = "正在启动…", sharedText = "";
  public volatile boolean importing;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private WifiManager.MulticastLock multicastLock;
  private PowerManager.WakeLock wakeLock;
  private static final String CHANNEL = "linx-transfers";
  public static final String IMPORT = "local.linx.android.IMPORT", STOP = "local.linx.android.STOP";

  @Override
  public void onCreate() {
    super.onCreate();
    current = this;
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(CHANNEL, "局域网传输", NotificationManager.IMPORTANCE_LOW));
    Notification n = notification("同一 Wi-Fi 下可被电脑发现");
    if (Build.VERSION.SDK_INT >= 29)
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    else startForeground(1, n);
    try {
      WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
      if (wifi != null) {
        multicastLock = wifi.createMulticastLock("linx-discovery");
        multicastLock.setReferenceCounted(false);
        multicastLock.acquire();
      }
    } catch (Exception ignored) {
    }
    io.execute(
        () -> {
          try {
            File base = new File(getFilesDir(), "linx");
            File staging = new File(base, "sending");
            SourceImporter.delete(staging);
            staging.mkdirs();
            LanEngine e = new LanEngine(base, Build.MANUFACTURER + " " + Build.MODEL);
            e.listener =
                () -> {
                  revision.incrementAndGet();
                  keepAwake(e.hasActiveTransfers() || importing);
                };
            e.notification =
                text -> {
                  NotificationManager nm = getSystemService(NotificationManager.class);
                  nm.notify(2, notification(text));
                };
            e.start();
            engine = e;
            status = "已开启局域网发现";
            revision.incrementAndGet();
          } catch (Exception e) {
            status = "启动失败：" + e.getMessage();
            revision.incrementAndGet();
          }
        });
  }

  private Notification notification(String text) {
    Intent open = new Intent(this, MainActivity.class);
    PendingIntent content =
        PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Intent stop = new Intent(this, TransferService.class).setAction(STOP);
    PendingIntent stopIntent =
        PendingIntent.getService(
            this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_linx)
        .setContentTitle("邻讯 · 局域网传输")
        .setContentText(text)
        .setContentIntent(content)
        .setOngoing(true)
        .addAction(new Notification.Action.Builder(null, "停止服务", stopIntent).build())
        .build();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && STOP.equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (intent != null && IMPORT.equals(intent.getAction())) {
      ArrayList<Uri> uris = intent.getParcelableArrayListExtra("uris");
      boolean tree = intent.getBooleanExtra("tree", false);
      String text = intent.getStringExtra("text");
      if (text != null && !text.trim().isEmpty()) {
        sharedText = text;
        revision.incrementAndGet();
      }
      if (uris != null && !uris.isEmpty()) {
        importing = true;
        status = "正在暂存共享文件…";
        revision.incrementAndGet();
        io.execute(
            () -> {
              try {
                if (engine == null) throw new IOException("服务尚未启动");
                List<File> imported =
                    new SourceImporter(
                            this,
                            new File(engine.home, "sending"),
                            queue,
                            (name, bytes) -> {
                              status = "正在导入 " + name + " · " + MainActivity.formatBytes(bytes);
                              revision.incrementAndGet();
                            })
                        .importUris(uris, tree);
                queue.addAll(imported);
                status = "已准备 " + queue.size() + " 项，选择终端后发送";
              } catch (Exception e) {
                status = "导入失败：" + e.getMessage();
              } finally {
                importing = false;
                revision.incrementAndGet();
              }
            });
      }
    }
    return START_NOT_STICKY;
  }

  public void submit(String peerId, java.util.function.Consumer<String> result) {
    List<File> files = new ArrayList<>(queue);
    if (files.isEmpty()) {
      result.accept("请先选择图片或文件");
      return;
    }
    engine.execute(
        () -> {
          try {
            engine.sendFiles(peerId, files);
            queue.removeAll(files);
            status = "已发送请求，等待对方接收";
            revision.incrementAndGet();
            result.accept(null);
          } catch (Exception e) {
            result.accept(e.getMessage());
          }
        });
  }

  public void clearQueue() {
    queue.clear();
    status = "已清空待发送列表";
    revision.incrementAndGet();
  }

  public void keepAwake(boolean active) {
    try {
      if (active) {
        if (wakeLock == null)
          wakeLock =
              ((PowerManager) getSystemService(POWER_SERVICE))
                  .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "linx:transfer");
        if (!wakeLock.isHeld()) wakeLock.acquire(15 * 60 * 1000L);
      } else if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    } catch (Exception ignored) {
    }
  }

  @Override
  public void onTimeout(int startId, int fgsType) {
    status = "系统已达到后台传输时限，请重新打开邻讯";
    stopSelf();
  }

  @Override
  public void onDestroy() {
    current = null;
    io.shutdownNow();
    if (engine != null) engine.close();
    keepAwake(false);
    if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
