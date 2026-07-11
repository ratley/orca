import { describe, expect, test } from "bun:test";

import { AdapterRegistry } from "../../../lane/adapter";
import { AgentManifestSchema } from "../../../types/lane";
import { registerClaudeAdapter } from "../index";

describe("claude adapter registration", () => {
  test("registers explicitly into the supplied registry", () => {
    const registry = new AdapterRegistry();

    const adapter = registerClaudeAdapter(registry, { permissionMode: "acceptEdits" });

    expect(registry.get("claude")).toBe(adapter);
    expect(registry.require("claude")).toBe(adapter);
  });

  test("the registered manifest is contract-valid", () => {
    const registry = new AdapterRegistry();
    const manifest = registerClaudeAdapter(registry).capabilities();

    expect(AgentManifestSchema.parse(manifest).agent).toBe("claude");
    expect(manifest.capabilities.kill).toBe(true);
  });
});
