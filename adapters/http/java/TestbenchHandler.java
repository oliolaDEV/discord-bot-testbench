package testbench;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.function.Function;

public final class TestbenchHandler implements HttpHandler {
    private final byte[] authorization;
    private final Function<String, String> dispatch;

    public TestbenchHandler(String secret, Function<String, String> dispatch) {
        if (secret.length() < 32) throw new IllegalArgumentException("Testbench secret must contain at least 32 characters");
        this.authorization = ("Bearer " + secret).getBytes(StandardCharsets.UTF_8);
        this.dispatch = dispatch;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        String provided = exchange.getRequestHeaders().getFirst("Authorization");
        if (!MessageDigest.isEqual(authorization, (provided == null ? "" : provided).getBytes(StandardCharsets.UTF_8))) {
            send(exchange, 401, "{\"error\":\"Unauthorized\"}");
            return;
        }
        if (!exchange.getRequestMethod().equals("POST") || exchange.getRequestHeaders().containsKey("Origin")) {
            send(exchange, 403, "{\"error\":\"Unsupported request\"}");
            return;
        }
        byte[] body = exchange.getRequestBody().readNBytes(1048577);
        if (body.length > 1048576) {
            send(exchange, 413, "{\"error\":\"Body too large\"}");
            return;
        }
        try {
            send(exchange, 200, dispatch.apply(new String(body, StandardCharsets.UTF_8)));
        } catch (RuntimeException error) {
            send(exchange, 500, "{\"error\":\"Handler failed\"}");
        }
    }

    private void send(HttpExchange exchange, int status, String body) throws IOException {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, data.length);
        exchange.getResponseBody().write(data);
        exchange.close();
    }
}
