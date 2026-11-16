using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace DiscordBotTestbench;

public static class TestbenchEndpoint
{
    public static void MapTestbench(this WebApplication app, string secret, Func<JsonElement, CancellationToken, Task<object>> dispatch)
    {
        if (secret.Length < 32) throw new ArgumentException("Testbench secret must contain at least 32 characters");
        app.MapPost("/testbench", async Task<IResult> (HttpContext context) =>
        {
            var actual = Encoding.UTF8.GetBytes(context.Request.Headers.Authorization.ToString());
            var expected = Encoding.UTF8.GetBytes("Bearer " + secret);
            if (!CryptographicOperations.FixedTimeEquals(actual, expected)) return Results.Unauthorized();
            if (context.Request.Headers.ContainsKey("Origin")) return Results.StatusCode(403);
            using var buffer = new MemoryStream();
            var bytes = new byte[8192];
            int count;
            while ((count = await context.Request.Body.ReadAsync(bytes, context.RequestAborted)) > 0)
            {
                if (buffer.Length + count > 1048576) return Results.StatusCode(413);
                await buffer.WriteAsync(bytes.AsMemory(0, count), context.RequestAborted);
            }
            try
            {
                using var document = JsonDocument.Parse(buffer.ToArray());
                return Results.Json(await dispatch(document.RootElement.Clone(), context.RequestAborted));
            }
            catch (JsonException)
            {
                return Results.BadRequest(new { error = "Invalid JSON" });
            }
        });
    }
}
