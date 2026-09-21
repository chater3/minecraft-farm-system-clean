package com.farm;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.time.Duration;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CaptchaClient {
    private static final String SOLVER_URL = "http://127.0.0.1:5000/solve";
    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private static final Pattern RESULT_PATTERN = Pattern.compile("\"result\"\\s*:\\s*\"([^\"]+)\"");

    public static String solveCaptcha(File imageFile) throws IOException, InterruptedException {
        String boundary = "----FarmBoundary" + UUID.randomUUID().toString().replace("-", "");
        byte[] fileBytes = Files.readAllBytes(imageFile.toPath());
        String fileName = imageFile.getName();

        byte[] body = buildMultipartBody(boundary, fileName, fileBytes);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(SOLVER_URL))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();

        HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Ошибка Flask-сервера: HTTP " + response.statusCode() + " " + response.body());
        }

        Matcher matcher = RESULT_PATTERN.matcher(response.body());
        if (matcher.find()) {
            return matcher.group(1);
        }
        return "";
    }

    private static byte[] buildMultipartBody(String boundary, String fileName, byte[] fileBytes) throws IOException {
        String header = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\n"
                + "Content-Type: image/png\r\n\r\n";
        String footer = "\r\n--" + boundary + "--\r\n";

        byte[] headerBytes = header.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] footerBytes = footer.getBytes(java.nio.charset.StandardCharsets.UTF_8);

        byte[] body = new byte[headerBytes.length + fileBytes.length + footerBytes.length];
        System.arraycopy(headerBytes, 0, body, 0, headerBytes.length);
        System.arraycopy(fileBytes, 0, body, headerBytes.length, fileBytes.length);
        System.arraycopy(footerBytes, 0, body, headerBytes.length + fileBytes.length, footerBytes.length);
        return body;
    }
}
