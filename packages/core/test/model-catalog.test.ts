import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { estimateCost, getContextLimit, getKnownModels } from "../dist/models.js";

// Rows contain context, input, output, cached input, and cache-write rates (null means omitted).
type ModelRow = [number, number, number, number, number | null];
const catalog = JSON.parse(readFileSync(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8"));

describe("reviewed upstream model catalog", () => {
  for (const [provider, models] of Object.entries(catalog.providers) as [string, Record<string, ModelRow>][]) {
    for (const [model, [context, input, output, cachedInput, cacheWrite]] of Object.entries(models)) {
      it(`resolves ${provider}/${model} with standard short-context pricing`, () => {
        const id = `${provider}/${model}`;
        assert.equal(getContextLimit(id), context);
        assert.equal(getContextLimit(id.toUpperCase()), context);
        assert.equal(getContextLimit(`${id}-latest`), context);
        assert.equal(estimateCost(id, 1000, 0), Math.round(input * 1000) / 1000000);
        assert.equal(estimateCost(id, 0, 1000), Math.round(output * 1000) / 1000000);
        assert.equal(estimateCost(id, 0, 0, 1000), Math.round(cachedInput * 1000) / 1000000);
        if (cacheWrite !== null) {
          assert.equal(estimateCost(id, 0, 0, 0, 1000), Math.round(cacheWrite * 1000) / 1000000);
        }
        assert.equal(getContextLimit(`${id}-fictional`), 256000);
        assert.equal(estimateCost(`${id}-fictional`, 1000, 1000), null);
      });
    }
  }

  it("keeps tier-dependent or regional models context-only", () => {
    for (const [model, context] of Object.entries(catalog.contextOnly)) {
      assert.equal(getContextLimit(model), context);
      assert.equal(estimateCost(model, 1000, 1000), null);
      const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
      assert.ok(!getKnownModels().includes(id));
    }
  });
});
