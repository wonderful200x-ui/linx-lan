package local.linx.android.core;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Bounded HTTP/1.1 framing shared by Android and the JVM interoperability test. */
public final class Wire {
  private Wire() {}

  public static String line(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    int previous = -1;
    for (int c; (c = in.read()) != -1; ) {
      if (previous == '\r' && c == '\n') {
        byte[] b = out.toByteArray();
        return new String(b, 0, b.length - 1, StandardCharsets.ISO_8859_1);
      }
      out.write(c);
      previous = c;
      if (out.size() > 8192) throw new IOException("HTTP 行过长");
    }
    throw new EOFException("连接已关闭");
  }

  public static Map<String, String> headers(InputStream in) throws IOException {
    Map<String, String> result = new HashMap<>();
    int size = 0;
    while (true) {
      String s = line(in);
      size += s.length();
      if (size > 32768) throw new IOException("请求头过大");
      if (s.isEmpty()) return result;
      int i = s.indexOf(':');
      if (i < 1) throw new IOException("请求头无效");
      String key = s.substring(0, i).toLowerCase(Locale.ROOT);
      if (result.containsKey(key)) throw new IOException("重复请求头");
      result.put(key, s.substring(i + 1).trim());
    }
  }

  public static void ascii(OutputStream out, String value) throws IOException {
    out.write(value.getBytes(StandardCharsets.ISO_8859_1));
  }

  public interface Sink {
    void write(byte[] bytes, int offset, int length) throws Exception;
  }

  public static Map<String, String> body(
      InputStream in, Map<String, String> headers, long max, Sink sink) throws Exception {
    long total = 0;
    byte[] buffer = new byte[65536];
    String encoding = headers.get("transfer-encoding");
    if (encoding != null) {
      if (!encoding.equalsIgnoreCase("chunked") || headers.containsKey("content-length"))
        throw new IOException("HTTP 编码无效");
      while (true) {
        String s = line(in).split(";", 2)[0];
        long length;
        try {
          length = Long.parseLong(s, 16);
        } catch (NumberFormatException e) {
          throw new IOException("分块长度无效");
        }
        if (length < 0 || length > max - total) throw new IOException("文件大小超出清单");
        if (length == 0) return headers(in);
        long remaining = length;
        while (remaining > 0) {
          int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
          if (n < 0) throw new EOFException("文件传输中断");
          sink.write(buffer, 0, n);
          remaining -= n;
          total += n;
        }
        if (!line(in).isEmpty()) throw new IOException("分块分隔符无效");
      }
    }
    long length;
    try {
      length = Long.parseLong(headers.getOrDefault("content-length", "0"));
    } catch (NumberFormatException e) {
      throw new IOException("内容长度无效");
    }
    if (length < 0 || length > max) throw new IOException("内容长度超限");
    while (total < length) {
      int n = in.read(buffer, 0, (int) Math.min(buffer.length, length - total));
      if (n < 0) throw new EOFException("内容不完整");
      sink.write(buffer, 0, n);
      total += n;
    }
    return Collections.emptyMap();
  }

  public static JSONObject jsonBody(InputStream in, Map<String, String> headers) throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    body(in, headers, 4L * 1024 * 1024, bytes::write);
    return new JSONObject(bytes.toString("UTF-8"));
  }

  public static void respond(OutputStream out, int status, JSONObject value) throws IOException {
    byte[] data = value.toString().getBytes(StandardCharsets.UTF_8);
    ascii(
        out,
        "HTTP/1.1 "
            + status
            + " "
            + (status == 200 ? "OK" : "Error")
            + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
            + data.length
            + "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
    out.write(data);
    out.flush();
  }

  public static JSONObject object(Object... values) {
    JSONObject result = new JSONObject();
    try {
      for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1]);
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
    return result;
  }

  public static JSONObject request(
      String address, int port, String token, String route, JSONObject data, String method)
      throws Exception {
    if (!address.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}") || port < 1 || port > 65535)
      throw new IOException("请输入 IPv4 地址和端口");
    for (String part : address.split("\\."))
      if (Integer.parseInt(part) > 255) throw new IOException("IPv4 地址无效");
    HttpURLConnection c =
        (HttpURLConnection)
            new URL("http://" + address + ":" + port + route).openConnection(Proxy.NO_PROXY);
    try {
      c.setConnectTimeout(5000);
      c.setReadTimeout(15000);
      c.setRequestMethod(method);
      c.setRequestProperty("x-linx-token", token == null ? "" : token);
      if (data != null) {
        byte[] b = data.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(b.length);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) {
          out.write(b);
        }
      }
      int code = c.getResponseCode();
      InputStream stream = code < 400 ? c.getInputStream() : c.getErrorStream();
      if (stream == null) throw new IOException("对方未返回数据");
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      try (InputStream in = stream) {
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) != -1; ) {
          if (bytes.size() + n > 5 * 1024 * 1024) throw new IOException("响应过大");
          bytes.write(b, 0, n);
        }
      }
      JSONObject response = new JSONObject(bytes.toString("UTF-8"));
      if (code >= 400) throw new IOException(response.optString("error", "请求失败"));
      return response;
    } finally {
      c.disconnect();
    }
  }
}
