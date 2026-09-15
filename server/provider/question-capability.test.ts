import { describe, expect, it } from "vitest";

import { withQuestionCapability } from "./omo-session.js";

/**
 * The approval panel has always been able to render a question; OmO just never
 * sent one, because the question request is opt-in and this client never said
 * it could present it. The advertisement has to be additive: a capability list
 * already carried by the environment belongs to whoever set it.
 */
describe("withQuestionCapability", () => {
  it("advertises the capability when nothing else does", () => {
    expect(withQuestionCapability(undefined)).toBe("question");
    expect(withQuestionCapability("")).toBe("question");
  });

  it("keeps capabilities the environment already asked for", () => {
    expect(withQuestionCapability("extension_events,media_placeholders")).toBe(
      "extension_events,media_placeholders,question",
    );
  });

  it("does not advertise it twice", () => {
    expect(withQuestionCapability("question")).toBe("question");
    expect(withQuestionCapability("extension_events,question")).toBe("extension_events,question");
  });

  it("ignores the whitespace and empty entries of a hand-written list", () => {
    expect(withQuestionCapability(" extension_events , , auto_title_sessions ")).toBe(
      "extension_events,auto_title_sessions,question",
    );
  });
});
