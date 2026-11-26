// Model badge must never render a garbled provider fragment (review P1-6).
// Imports the real client component module to lock the provider-label mapping.
import { describe, expect, it } from "vitest";
import { providerDisplay } from "@/components/response-status";

describe("providerDisplay", () => {
  it("maps known provider ids to clean labels", () => {
    expect(providerDisplay("groq")).toBe("Groq");
    expect(providerDisplay("openai")).toBe("OpenAI");
    expect(providerDisplay("together")).toBe("Together");
    expect(providerDisplay("cloudflare")).toBe("Cloudflare");
  });

  it("cleans up a garbled token instead of echoing it", () => {
    // The live review observed "Greq" — it must render as "Groq".
    expect(providerDisplay("Greq")).toBe("Groq");
    expect(providerDisplay("greq")).toBe("Groq");
    expect(providerDisplay("GROQ")).toBe("Groq");
  });

  it("title-cases unknown providers and ignores noise", () => {
    expect(providerDisplay("my-provider_1")).toBe("Myprovider1");
    expect(providerDisplay("")).toBeNull();
    expect(providerDisplay(null)).toBeNull();
    expect(providerDisplay(undefined)).toBeNull();
  });
});
