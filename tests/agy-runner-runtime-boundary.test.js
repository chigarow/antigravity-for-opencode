import { describe, test, expect } from "bun:test";
import { buildAgyArgs, AgyError } from "../src/agy-runner";

/**
 * Cast-free runtime boundary: invalid tier strings cross the public JS API
 * without TypeScript escapes (as any / @ts-ignore / @ts-expect-error).
 */
const REMOVED_HIGH = ["flash-3.5", "pro-3.1", "flash-3.6"];

describe("INVALID_TIER runtime boundary (cast-free)", () => {
  for (const tier of REMOVED_HIGH) {
    test(`throws INVALID_TIER for removed tier ${tier} without model`, () => {
      // Given: removed unsuffixed High name, no model override
      // When: buildAgyArgs is called at the JS boundary
      // Then: AgyError with code INVALID_TIER
      try {
        buildAgyArgs({ prompt: "x", tier });
        throw new Error("expected AgyError");
      } catch (e) {
        expect(e).toBeInstanceOf(AgyError);
        expect(e.code).toBe("INVALID_TIER");
      }
    });

    test(`throws INVALID_TIER for removed tier ${tier} even with model override`, () => {
      // Given: removed tier plus exact model override
      // When: buildAgyArgs is called
      // Then: still INVALID_TIER — model must not bypass tier validation
      try {
        buildAgyArgs({
          prompt: "x",
          tier,
          model: "Gemini 3.5 Flash (High)",
        });
        throw new Error("expected AgyError");
      } catch (e) {
        expect(e).toBeInstanceOf(AgyError);
        expect(e.code).toBe("INVALID_TIER");
      }
    });
  }
});
