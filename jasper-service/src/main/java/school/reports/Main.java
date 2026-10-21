package school.reports;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * The school ERP's report renderer: a JasperReports design (.jrxml) + rows of data in, PDF / Excel /
 * Word out. It never reads a database: the ERP backend checks who is asking, gathers only the rows
 * they may see and sends them here.
 *
 *   GET  /health    is it running
 *   POST /inspect   {design}                         → the design's fields and parameters (or its mistakes)
 *   POST /render    {design, format, rows, params}   → the file
 *
 * Settings (environment): HOST (default 127.0.0.1), PORT (8090), JASPER_TOKEN (the backend sends it as
 * "Authorization: Bearer …"; without one the service only listens on this computer), JASPER_THREADS,
 * JASPER_MAX_PAGES (5000), JASPER_TIMEOUT_SECONDS (120), JASPER_MAX_BODY_MB (50).
 */
public final class Main {
    static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v.trim();
    }

    public static void main(String[] args) throws IOException {
        System.setProperty("java.awt.headless", "true");
        String host = env("HOST", "127.0.0.1");
        int port = Integer.parseInt(env("PORT", "8090"));
        String token = env("JASPER_TOKEN", "");
        if (token.isEmpty() && !host.equals("127.0.0.1") && !host.equals("localhost")) {
            System.err.println("JASPER_TOKEN is required when listening on " + host + " (only 127.0.0.1 may run without one)");
            System.exit(1);
        }
        long maxBody = Long.parseLong(env("JASPER_MAX_BODY_MB", "50")) * 1024 * 1024;
        int threads = Integer.parseInt(env("JASPER_THREADS", String.valueOf(Math.max(2, Runtime.getRuntime().availableProcessors()))));
        Renderer renderer = new Renderer(Integer.parseInt(env("JASPER_MAX_PAGES", "5000")), Integer.parseInt(env("JASPER_TIMEOUT_SECONDS", "120")));

        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.setExecutor(Executors.newFixedThreadPool(threads));

        server.createContext("/health", ex -> {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "ok");
            body.put("jasperreports", Renderer.VERSION);
            sendJson(ex, 200, body);
        });

        server.createContext("/inspect", ex -> handle(ex, token, maxBody, req -> {
            sendJson(ex, 200, renderer.inspect(text(req, "design")));
        }));

        server.createContext("/render", ex -> handle(ex, token, maxBody, req -> {
            String format = req.path("format").asText("pdf");
            Renderer.Output out = renderer.render(text(req, "design"), format, Main.<List<Map<String, Object>>>convert(req.get("rows"), List.class), Main.<Map<String, Object>>convert(req.get("params"), Map.class));
            ex.getResponseHeaders().set("Content-Type", out.contentType());
            ex.getResponseHeaders().set("X-Pages", String.valueOf(out.pages()));
            ex.sendResponseHeaders(200, out.bytes().length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(out.bytes());
            }
        }));

        server.start();
        System.out.println("Report renderer (JasperReports " + Renderer.VERSION + ") on http://" + host + ":" + port + (token.isEmpty() ? " (no token: this computer only)" : ""));
    }

    interface Handler {
        void run(JsonNode body) throws Exception;
    }

    private static void handle(HttpExchange ex, String token, long maxBody, Handler handler) throws IOException {
        long started = System.currentTimeMillis();
        try {
            if (!"POST".equals(ex.getRequestMethod())) {
                sendError(ex, 405, "internal", "Use POST", null);
                return;
            }
            if (!token.isEmpty()) {
                String auth = ex.getRequestHeaders().getFirst("Authorization");
                byte[] given = (auth == null ? "" : auth).getBytes(StandardCharsets.UTF_8);
                byte[] wanted = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
                if (!MessageDigest.isEqual(given, wanted)) {
                    sendError(ex, 401, "auth", "Not allowed", null);
                    return;
                }
            }
            byte[] raw;
            try (InputStream in = ex.getRequestBody()) {
                raw = in.readNBytes((int) Math.min(Integer.MAX_VALUE - 8, maxBody + 1));
            }
            if (raw.length > maxBody) {
                sendError(ex, 413, "limit", "Too much data for one report", null);
                return;
            }
            handler.run(JSON.readTree(raw));
        } catch (ReportException e) {
            sendError(ex, e.status, e.kind, e.getMessage(), e.detail);
        } catch (Exception e) {
            e.printStackTrace();
            sendError(ex, 500, "internal", "The report could not be made", e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            System.out.println(ex.getRequestMethod() + " " + ex.getRequestURI().getPath() + " " + ex.getResponseCode() + " " + (System.currentTimeMillis() - started) + "ms");
            ex.close();
        }
    }

    private static String text(JsonNode req, String field) {
        JsonNode n = req.get(field);
        if (n == null || !n.isTextual() || n.asText().isBlank()) throw new ReportException(400, "design", "No report design was sent", null);
        return n.asText();
    }

    @SuppressWarnings("unchecked")
    private static <T> T convert(JsonNode node, Class<?> type) {
        if (node == null || node.isNull()) return null;
        return (T) JSON.convertValue(node, type);
    }

    static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void sendError(HttpExchange ex, int status, String kind, String message, String detail) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kind", kind);
        body.put("error", message);
        if (detail != null) body.put("detail", detail);
        sendJson(ex, status, body);
    }
}
